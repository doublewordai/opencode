/**
 * PR review harness for the COR-364 experiment.
 *
 * Two trigger paths feed one review pipeline:
 *
 *   1. Webhook    — POST /webhook from a GitHub pull_request event.
 *                   Trusted (HMAC-verified). The review IS posted back to the PR.
 *   2. Polling    — every POLL_INTERVAL_MS, list open PRs across WATCHED_REPOS
 *                   created in the last POLL_INTERVAL_MS hours. Treated as
 *                   read-only — the rendered review is logged to stdout, never
 *                   posted. No persistent "seen" state; cron-style stateless.
 *
 * The pipeline (clone → opencode session → extract markdown) is shared. The
 * post step is a callback so each path can attach its own behaviour.
 *
 * The shim self-supervises opencode-server as a child process when
 * OPENCODE_SERVER_URL is unset (single-container Cloud Run pattern). When
 * OPENCODE_SERVER_URL is set, the shim assumes an external server (local dev,
 * docker-compose).
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest"
import { createAppAuth } from "@octokit/auth-app"

const DEFAULT_OPENCODE_PORT = 14123

const env = {
  DOUBLEWORD_API_KEY: requireEnv("DOUBLEWORD_API_KEY"),
  GITHUB_APP_ID: requireEnv("GITHUB_APP_ID"),
  GITHUB_INSTALLATION_ID: requireEnv("GITHUB_INSTALLATION_ID"),
  GITHUB_PRIVATE_KEY: requireEnv("GITHUB_PRIVATE_KEY"),
  GITHUB_WEBHOOK_SECRET: requireEnv("GITHUB_WEBHOOK_SECRET"),
  OPENCODE_SERVER_PASSWORD: requireEnv("OPENCODE_SERVER_PASSWORD"),
  OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL,
  OPENCODE_BIN: process.env.OPENCODE_BIN ?? "opencode",
  PORT: Number(process.env.PORT ?? 8080),
  REVIEW_AGENT: process.env.REVIEW_AGENT ?? "review",
  REVIEW_MODEL_PROVIDER: process.env.REVIEW_MODEL_PROVIDER ?? "doubleword",
  // REVIEW_MODEL_ID is the source of truth for which Doubleword-served model
  // the agent runs. opencode.json registers the model as `{env:REVIEW_MODEL_ID}`
  // (substituted at config-load time), so the model registry and the shim's
  // per-message override stay aligned automatically. Required — fail loud if
  // unset rather than registering an empty model and 404-ing at runtime.
  REVIEW_MODEL_ID: requireEnv("REVIEW_MODEL_ID"),
  // Per-HTTP-call safety. Each call to opencode is now trivial (POST returns
  // 204 immediately; GET messages returns the current state) so 30s is plenty.
  // Bun's fetch has an internal ~5-min idle-read default that we can't override
  // with AbortSignal.timeout — that's why review used to time out at ~5 min
  // when the v1 /message endpoint was synchronous. The async refactor below
  // routes around that by never holding any one request open for long.
  OPENCODE_FETCH_TIMEOUT_MS: Number(process.env.OPENCODE_FETCH_TIMEOUT_MS ?? 30 * 1000),
  // Overall ceiling on the agent loop. 30 min is well under the Cloud Run
  // 60-min request cap and well above the observed range of legitimate
  // research-heavy reviews. Past this, the loop has likely stalled.
  REVIEW_TIMEOUT_MS: Number(process.env.REVIEW_TIMEOUT_MS ?? 30 * 60 * 1000),
  // Polling interval when waiting for the assistant message to complete.
  // 5s is fine — the agent loop runs in seconds-to-minutes, not milliseconds.
  REVIEW_POLL_INTERVAL_MS: Number(process.env.REVIEW_POLL_INTERVAL_MS ?? 5 * 1000),
  // opencode loads agent + provider config from this file relative to the
  // workspace directory (the x-opencode-directory header value). We copy this
  // file into each cloned PR worktree so the `review` agent + Doubleword
  // provider are available to that session.
  OPENCODE_CONFIG_PATH: process.env.OPENCODE_CONFIG_PATH ?? "/app/opencode.json",
  WATCHED_REPOS: (process.env.WATCHED_REPOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS ?? 24 * 60 * 60 * 1000),
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

// GitHub App authentication. The Octokit instance auto-mints + caches
// installation tokens (1h validity); auth({ type: "installation" }) returns
// the current token, which we use for git clone HTTPS auth.
const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId: env.GITHUB_INSTALLATION_ID,
  },
})

async function installationToken(): Promise<string> {
  const auth = (await octokit.auth({ type: "installation" })) as { token: string }
  return auth.token
}

const opencodeAuth = "Basic " + Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")

type PullRequestEvent = {
  action: string
  pull_request: {
    number: number
    head: { ref: string; sha: string }
    base: { ref: string }
    title: string
  }
  repository: { clone_url: string; owner: { login: string }; name: string }
}

type ReviewInput = {
  owner: string
  repo: string
  prNumber: number
  prTitle: string
  baseBranch: string
  headRef: string
  cloneUrl: string
}

type ReviewSeverity = "Blocking" | "Non-blocking" | "Nit"

type InlineReviewComment = {
  path: string
  line: number
  side?: "LEFT" | "RIGHT"
  severity?: ReviewSeverity
  body: string
  // Optional: the literal diff line content the model claims to be commenting
  // on. Used for pre-validation against the actual PR diff so we never send
  // an inline comment to GitHub with a line ref that doesn't match what's at
  // that line. Mismatches get demoted to general findings rather than 422-ing
  // the entire createReview call. See the prompt schema in opencode.json.
  code?: string
}

type ParsedReview = {
  summary: string
  comments: InlineReviewComment[]
}

type Poster = (parsed: ParsedReview, raw: string) => Promise<void>

const TRIGGER_ACTIONS = new Set(["opened", "synchronize", "reopened"])

async function main() {
  const opencodeServerUrl = await ensureOpencodeServer()

  const server = Bun.serve({
    port: env.PORT,
    fetch: async (req) => handleHttp(req, opencodeServerUrl),
  })
  console.log(`pr-review-shim listening on http://localhost:${server.port}`)

  if (env.WATCHED_REPOS.length > 0) {
    console.log(
      `polling ${env.WATCHED_REPOS.length} repo(s) every ${env.POLL_INTERVAL_MS}ms: ${env.WATCHED_REPOS.join(", ")}`,
    )
    pollWatchedRepos(opencodeServerUrl).catch((err) => console.error("initial poll failed", err))
    setInterval(() => {
      pollWatchedRepos(opencodeServerUrl).catch((err) => console.error("scheduled poll failed", err))
    }, env.POLL_INTERVAL_MS)
  }
}

async function ensureOpencodeServer(): Promise<string> {
  if (env.OPENCODE_SERVER_URL) {
    console.log(`using external opencode server at ${env.OPENCODE_SERVER_URL}`)
    await waitForOpencodeReady(env.OPENCODE_SERVER_URL)
    return env.OPENCODE_SERVER_URL
  }

  const url = `http://127.0.0.1:${DEFAULT_OPENCODE_PORT}`
  console.log(`spawning opencode server: ${env.OPENCODE_BIN} serve --hostname 127.0.0.1 --port ${DEFAULT_OPENCODE_PORT}`)

  const child = spawn(
    env.OPENCODE_BIN,
    ["serve", "--hostname", "127.0.0.1", "--port", String(DEFAULT_OPENCODE_PORT)],
    {
      stdio: "inherit",
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: env.OPENCODE_SERVER_PASSWORD },
    },
  )
  child.on("exit", (code, signal) => {
    console.error(`opencode server exited code=${code} signal=${signal} — aborting`)
    process.exit(code ?? 1)
  })
  forwardSignals(child)
  await waitForOpencodeReady(url)
  console.log(`opencode server ready at ${url}`)
  return url
}

function forwardSignals(child: ChildProcess) {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => child.kill(sig))
  }
}

async function waitForOpencodeReady(url: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/session?limit=1`, { headers: { authorization: opencodeAuth } })
      if (res.ok) return
    } catch {
      // server not up yet; retry
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`opencode server not ready at ${url} within 60s`)
}

async function handleHttp(req: Request, opencodeServerUrl: string): Promise<Response> {
  const url = new URL(req.url)
  // Cloud Run reserves /healthz for its own startup probes — use /health.
  if (url.pathname === "/health") return new Response("ok")
  if (url.pathname !== "/webhook" || req.method !== "POST") return new Response("not found", { status: 404 })

  const body = await req.text()
  const sigHeader = req.headers.get("x-hub-signature-256")
  if (!sigHeader || !verifySignature(body, sigHeader)) return new Response("invalid signature", { status: 401 })

  const eventType = req.headers.get("x-github-event")
  if (eventType !== "pull_request") return new Response("ignored", { status: 200 })

  const event = JSON.parse(body) as PullRequestEvent
  if (!TRIGGER_ACTIONS.has(event.action)) return new Response("ignored", { status: 200 })

  const input: ReviewInput = {
    owner: event.repository.owner.login,
    repo: event.repository.name,
    prNumber: event.pull_request.number,
    prTitle: event.pull_request.title,
    baseBranch: event.pull_request.base.ref,
    headRef: event.pull_request.head.ref,
    cloneUrl: event.repository.clone_url,
  }
  // Fire-and-forget — webhook should return quickly so GitHub doesn't retry.
  runReview(input, opencodeServerUrl, postAsReview(input)).catch((err) =>
    console.error(`[${tagOf(input)}] webhook review failed`, err),
  )
  return new Response("queued", { status: 202 })
}

async function pollWatchedRepos(opencodeServerUrl: string): Promise<void> {
  const since = Date.now() - env.POLL_INTERVAL_MS
  for (const spec of env.WATCHED_REPOS) {
    const [owner, repo] = spec.split("/")
    if (!owner || !repo) {
      console.warn(`[poll] invalid WATCHED_REPOS entry: ${spec}`)
      continue
    }
    try {
      const recent = await listRecentPRs(owner, repo, since)
      console.log(`[poll] ${spec}: ${recent.length} recent PR(s)`)
      for (const pr of recent) {
        const input: ReviewInput = {
          owner,
          repo,
          prNumber: pr.number,
          prTitle: pr.title,
          baseBranch: pr.base.ref,
          headRef: pr.head.ref,
          cloneUrl: pr.base.repo.clone_url,
        }
        try {
          await runReview(input, opencodeServerUrl, postAsLog(input))
        } catch (err) {
          console.error(`[${tagOf(input)}] poll review failed`, err)
        }
      }
    } catch (err) {
      console.error(`[poll] ${spec} listing failed`, err)
    }
  }
}

async function listRecentPRs(
  owner: string,
  repo: string,
  sinceMs: number,
): Promise<RestEndpointMethodTypes["pulls"]["list"]["response"]["data"]> {
  // pulls.list defaults to sort=created direction=desc, so we can short-circuit
  // on the first PR older than `sinceMs`. 100 results per page is enough; if
  // any project opens >100 PRs in 24h we have bigger problems than coverage.
  const { data } = await octokit.rest.pulls.list({ owner, repo, state: "open", per_page: 100 })
  const recent: typeof data = []
  for (const pr of data) {
    if (Date.parse(pr.created_at) < sinceMs) break
    recent.push(pr)
  }
  return recent
}

async function runReview(input: ReviewInput, opencodeServerUrl: string, post: Poster): Promise<void> {
  const tag = tagOf(input)
  // mkdtemp won't create intermediate directories — sanitize slashes/anything
  // non-alphanumeric to keep the path a single component.
  const fsTag = tag.replace(/[^a-z0-9-]/gi, "-")
  const workdir = await mkdtemp(path.join(os.tmpdir(), `${fsTag}-`))
  console.log(`[${tag}] starting review at ${workdir}`)

  try {
    await cloneRepo({
      cloneUrl: await authedCloneUrl(input.cloneUrl),
      ref: input.headRef,
      baseRef: input.baseBranch,
      cwd: workdir,
    })
    // Make the review agent + Doubleword provider visible to the session.
    await copyFile(env.OPENCODE_CONFIG_PATH, path.join(workdir, "opencode.json"))
    const reviewText = await runReviewSession({ directory: workdir, opencodeServerUrl, tag, ...input })
    if (!reviewText) {
      console.error(`[${tag}] no review text returned from opencode`)
      return
    }
    const parsed = parseReviewOutput(reviewText, tag)
    await post(parsed, reviewText)
    console.log(
      `[${tag}] review delivered (${parsed.comments.length} inline comment${parsed.comments.length === 1 ? "" : "s"})`,
    )
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch((err) => console.error(`[${tag}] cleanup failed`, err))
  }
}

function postAsReview(input: ReviewInput): Poster {
  const tag = tagOf(input)
  return async (parsed, raw) => {
    // Validate every inline comment against the actual PR diff before calling
    // createReview. GitHub's createReview rejects the *entire* review with HTTP
    // 422 if any comment references a line outside the diff hunks — losing 11
    // valid findings to one stale ref. We pre-validate by fetching the PR's
    // file patches, building a map of valid {path → side → line → diff content},
    // and dropping any inline comment whose (path, line, side) isn't in it (or,
    // when the model provided a `code` self-check, whose `code` doesn't match
    // the actual diff line at that position). Rejected comments are demoted to
    // a "## General findings" section in the summary so we don't lose them.
    const diffLines = await fetchDiffLineMap(input).catch((err) => {
      console.warn(`[${tag}] failed to fetch PR diff for validation; posting unchecked: ${(err as Error).message}`)
      return null
    })
    const validated = diffLines ? validateInlineComments(parsed.comments, diffLines, tag) : { valid: parsed.comments, rejected: [] }
    const summary = validated.rejected.length > 0
      ? `${parsed.summary}\n\n${renderRejectedAsMarkdown(validated.rejected)}`
      : parsed.summary
    if (validated.rejected.length > 0) {
      console.warn(
        `[${tag}] ${validated.rejected.length}/${parsed.comments.length} inline comment(s) failed pre-validation; demoting to summary`,
      )
    }
    const apiComments = validated.valid.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? "RIGHT",
      body: c.body,
    }))
    try {
      await octokit.rest.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
        event: "COMMENT",
        body: summary,
        comments: apiComments,
      })
      return
    } catch (err) {
      // Even with pre-validation, GitHub may still 422 (subtle path/encoding
      // mismatches, or our patch parser missing edge cases). Log the response
      // body so we can diagnose, then fall back to summary-only with all
      // inline findings (validated or not) appended as markdown.
      const status = (err as { status?: number }).status
      const responseBody = (err as { response?: { data?: unknown } }).response?.data
      if (status !== 422) {
        console.error(
          `[${tag}] createReview failed status=${status} body=${JSON.stringify(responseBody).slice(0, 1500)}`,
        )
        throw err
      }
      console.warn(
        `[${tag}] createReview rejected ${apiComments.length} inline comment(s) (422); response body: ${JSON.stringify(responseBody).slice(0, 1500)}`,
      )
      await octokit.rest.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
        event: "COMMENT",
        body: parsed.comments.length > 0 ? `${parsed.summary}\n\n${renderCommentsAsMarkdown(parsed.comments)}` : raw,
      })
    }
  }
}

type DiffLineMap = Map<string, { right: Map<number, string>; left: Map<number, string> }>

async function fetchDiffLineMap(input: ReviewInput): Promise<DiffLineMap> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    per_page: 100,
  })
  const map: DiffLineMap = new Map()
  for (const f of files) {
    const right = new Map<number, string>()
    const left = new Map<number, string>()
    if (f.patch) {
      let rightLine = 0
      let leftLine = 0
      for (const line of f.patch.split("\n")) {
        const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
        if (hunkMatch && hunkMatch[1] && hunkMatch[2]) {
          leftLine = parseInt(hunkMatch[1], 10) - 1
          rightLine = parseInt(hunkMatch[2], 10) - 1
          continue
        }
        if (line.startsWith("+")) {
          rightLine++
          right.set(rightLine, line.slice(1))
        } else if (line.startsWith("-")) {
          leftLine++
          left.set(leftLine, line.slice(1))
        } else if (line.startsWith(" ")) {
          rightLine++
          leftLine++
          right.set(rightLine, line.slice(1))
          left.set(leftLine, line.slice(1))
        }
        // "\ No newline at end of file" — ignore
      }
    }
    map.set(f.filename, { right, left })
  }
  return map
}

function validateInlineComments(
  comments: InlineReviewComment[],
  diffLines: DiffLineMap,
  tag: string,
): { valid: InlineReviewComment[]; rejected: Array<{ comment: InlineReviewComment; reason: string }> } {
  const valid: InlineReviewComment[] = []
  const rejected: Array<{ comment: InlineReviewComment; reason: string }> = []
  for (const c of comments) {
    const fileEntry = diffLines.get(c.path)
    if (!fileEntry) {
      rejected.push({ comment: c, reason: `path "${c.path}" is not in the PR diff` })
      continue
    }
    const sideMap = (c.side ?? "RIGHT") === "LEFT" ? fileEntry.left : fileEntry.right
    const actualCode = sideMap.get(c.line)
    if (actualCode === undefined) {
      rejected.push({
        comment: c,
        reason: `line ${c.line} (side=${c.side ?? "RIGHT"}) is not part of any diff hunk in ${c.path}`,
      })
      continue
    }
    if (c.code !== undefined && c.code.trim() !== actualCode.trim()) {
      const expected = actualCode.trim().slice(0, 100)
      const got = c.code.trim().slice(0, 100)
      rejected.push({
        comment: c,
        reason: `code self-check failed at ${c.path}:${c.line}: diff has \`${expected}\`, model claimed \`${got}\``,
      })
      continue
    }
    valid.push(c)
  }
  for (const r of rejected) {
    console.warn(`[${tag}]   inline-validation reject: ${r.reason}`)
  }
  return { valid, rejected }
}

function renderRejectedAsMarkdown(rejected: Array<{ comment: InlineReviewComment; reason: string }>): string {
  const lines = ["## General findings (auto-demoted from inline due to pre-validation)", ""]
  for (const r of rejected) {
    const sev = r.comment.severity ? `**${r.comment.severity}** ` : ""
    const firstLine = r.comment.body.split("\n")[0]?.replace(/^\*\*[^*]+\*\*:?\s*/, "") ?? ""
    lines.push(`- ${sev}\`${r.comment.path}:${r.comment.line}\` — ${firstLine}`)
    lines.push(`  - *(demoted: ${r.reason})*`)
  }
  return lines.join("\n")
}

function postAsLog(input: ReviewInput): Poster {
  const tag = tagOf(input)
  return async (parsed) => {
    const inline = parsed.comments.length > 0 ? `\n\n${renderCommentsAsMarkdown(parsed.comments)}` : ""
    console.log(`\n=== [${tag}] review (log-only) ===\n${parsed.summary}${inline}\n=== end review ===\n`)
  }
}

function renderCommentsAsMarkdown(comments: InlineReviewComment[]): string {
  const lines = ["## Inline findings (could not anchor to diff)", ""]
  for (const c of comments) {
    const sev = c.severity ? `**${c.severity}** ` : ""
    lines.push(`- ${sev}\`${c.path}:${c.line}\` — ${c.body.split("\n")[0]}`)
  }
  return lines.join("\n")
}

const JSON_FENCE_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g

function parseReviewOutput(text: string, tag: string): ParsedReview {
  // Find the LAST fenced JSON block — agents sometimes include illustrative
  // JSON earlier (e.g. quoting the prompt's example schema) before the real one.
  let lastMatch: RegExpExecArray | null = null
  for (let m: RegExpExecArray | null; (m = JSON_FENCE_RE.exec(text)); ) lastMatch = m

  const jsonBody = lastMatch?.[1]
  if (!jsonBody) {
    console.warn(`[${tag}] no JSON block found in agent output; falling back to raw text as summary`)
    return { summary: text, comments: [] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(jsonBody)
  } catch (err) {
    console.warn(`[${tag}] JSON parse failed (${(err as Error).message}); falling back to raw text as summary`)
    return { summary: text, comments: [] }
  }

  if (!raw || typeof raw !== "object") {
    console.warn(`[${tag}] agent JSON is not an object; falling back to raw text as summary`)
    return { summary: text, comments: [] }
  }

  const obj = raw as Record<string, unknown>
  const summary = typeof obj.summary === "string" ? obj.summary : ""
  const commentsIn = Array.isArray(obj.comments) ? obj.comments : []
  const comments: InlineReviewComment[] = []
  for (const c of commentsIn) {
    if (!c || typeof c !== "object") continue
    const cc = c as Record<string, unknown>
    const path = typeof cc.path === "string" ? cc.path : null
    const line = typeof cc.line === "number" && Number.isInteger(cc.line) && cc.line > 0 ? cc.line : null
    const body = typeof cc.body === "string" ? cc.body : null
    if (!path || line === null || !body) continue
    const side = cc.side === "LEFT" ? "LEFT" : "RIGHT"
    const severity =
      cc.severity === "Blocking" || cc.severity === "Non-blocking" || cc.severity === "Nit" ? cc.severity : undefined
    const code = typeof cc.code === "string" ? cc.code : undefined
    comments.push({ path, line, side, severity, body, code })
  }
  if (!summary && comments.length === 0) {
    console.warn(`[${tag}] agent JSON had neither summary nor valid comments; falling back to raw text`)
    return { summary: text, comments: [] }
  }
  return { summary: summary || "(no summary returned)", comments }
}

function tagOf(input: ReviewInput): string {
  return `${input.owner}/${input.repo}#${input.prNumber}`
}

function verifySignature(body: string, header: string): boolean {
  const expected = "sha256=" + createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")
  if (header.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected))
}

async function authedCloneUrl(cloneUrl: string): Promise<string> {
  // GitHub App installation tokens authenticate HTTPS clones via the
  // x-access-token user, same as PATs. Token is short-lived (1h); minted
  // fresh per clone via the cached App auth strategy.
  const url = new URL(cloneUrl)
  url.username = "x-access-token"
  url.password = await installationToken()
  return url.toString()
}

async function cloneRepo(input: { cloneUrl: string; ref: string; baseRef: string; cwd: string }): Promise<void> {
  // Depth needs to be enough to reach the merge-base of HEAD and origin/<base>
  // so the agent's `git diff origin/<base>...HEAD` resolves; 500 is generous
  // for typical PR sizes without paying the cost of a full clone.
  await runCmd("git", ["clone", "--no-tags", "--depth=500", input.cloneUrl, "."], input.cwd)
  // No explicit dst (no `:<local>` refspec) — git refuses to fetch into a
  // local branch that's currently checked out (which the cloned default
  // branch always is). A bare `git fetch origin <ref>` updates the
  // remote-tracking branch `origin/<ref>` and FETCH_HEAD, which is enough.
  await runCmd("git", ["fetch", "origin", input.baseRef], input.cwd)
  await runCmd("git", ["fetch", "origin", input.ref], input.cwd)
  await runCmd("git", ["checkout", "FETCH_HEAD"], input.cwd)
}

function runCmd(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: "pipe" })
    let stderr = ""
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()))
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr}`))
    })
  })
}

type MessageInfo = {
  role: "user" | "assistant"
  time?: { created: number; completed?: number }
  error?: { message?: string; name?: string } | unknown
}

type MessagePart = { type: string; text?: string }

type MessageWithParts = { info: MessageInfo; parts: MessagePart[] }

async function runReviewSession(input: {
  directory: string
  opencodeServerUrl: string
  prTitle: string
  prNumber: number
  baseBranch: string
  tag: string
}): Promise<string | null> {
  // Two-phase, fully asynchronous flow. We don't use the v1 POST
  // /session/:id/message endpoint because it holds the HTTP connection open
  // for the entire agent loop, and Bun's fetch client has an internal ~5-min
  // idle-read timeout we can't override (AbortSignal.timeout is independent).
  // For research-heavy reviews with many tool loops, the loop exceeds 5 min
  // and the connection is killed mid-review.
  //
  // Instead: POST /session/:id/prompt_async, which forks the prompt into a
  // background fiber and returns 204 immediately. We then poll
  // GET /session/:id/message until the assistant message has time.completed
  // set (or info.error if it failed). Each individual HTTP call is short, so
  // the idle-read cap is never reached.
  const session = await opencode<{ id: string }>(input.opencodeServerUrl, "/session", {
    method: "POST",
    directory: input.directory,
    body: { title: `PR #${input.prNumber} review` },
  })

  const promptText = [
    `Review pull request #${input.prNumber}: ${input.prTitle}.`,
    `The base branch is \`${input.baseBranch}\`. The PR's HEAD is checked out at the current working directory.`,
    `Run \`git log ${input.baseBranch}..HEAD --stat\` and \`git diff ${input.baseBranch}...HEAD\` to find the change set, read relevant files for context, and produce a complete review comment as your final response per your system instructions.`,
  ].join("\n\n")

  await opencode<void>(input.opencodeServerUrl, `/session/${session.id}/prompt_async`, {
    method: "POST",
    directory: input.directory,
    expect: 204,
    body: {
      agent: env.REVIEW_AGENT,
      model: { providerID: env.REVIEW_MODEL_PROVIDER, modelID: env.REVIEW_MODEL_ID },
      parts: [{ type: "text", text: promptText }],
    },
  })

  return await pollForAssistantReply({
    opencodeServerUrl: input.opencodeServerUrl,
    directory: input.directory,
    sessionID: session.id,
    tag: input.tag,
  })
}

async function pollForAssistantReply(input: {
  opencodeServerUrl: string
  directory: string
  sessionID: string
  tag: string
}): Promise<string | null> {
  const deadline = Date.now() + env.REVIEW_TIMEOUT_MS
  let attempt = 0
  while (Date.now() < deadline) {
    attempt++
    const messages = await opencode<MessageWithParts[]>(
      input.opencodeServerUrl,
      `/session/${input.sessionID}/message`,
      { method: "GET", directory: input.directory },
    )
    // The session is fresh, so there's at most one assistant message — the
    // one for our prompt. Look at the last assistant message either way, in
    // case opencode ever inserts intermediate ones.
    const assistant = [...messages].reverse().find((m) => m.info.role === "assistant")
    if (assistant) {
      if (assistant.info.error) {
        throw new Error(
          `opencode session ${input.sessionID} ended in error: ${JSON.stringify(assistant.info.error).slice(0, 500)}`,
        )
      }
      if (assistant.info.time?.completed) {
        const text = [...assistant.parts].reverse().find((p) => p.type === "text")?.text
        return text ?? null
      }
    }
    if (attempt % 12 === 1) {
      console.log(
        `[${input.tag}] still waiting for assistant reply (${Math.round((Date.now() - (deadline - env.REVIEW_TIMEOUT_MS)) / 1000)}s elapsed, ${messages.length} message(s))`,
      )
    }
    await new Promise((r) => setTimeout(r, env.REVIEW_POLL_INTERVAL_MS))
  }
  throw new Error(
    `opencode session ${input.sessionID} did not complete within REVIEW_TIMEOUT_MS=${env.REVIEW_TIMEOUT_MS}ms`,
  )
}

async function opencode<T = unknown>(
  serverUrl: string,
  pathname: string,
  options: { method: string; directory: string; body?: unknown; expect?: number },
): Promise<T> {
  const res = await fetch(`${serverUrl}${pathname}`, {
    method: options.method,
    headers: {
      "content-type": "application/json",
      authorization: opencodeAuth,
      "x-opencode-directory": options.directory,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(env.OPENCODE_FETCH_TIMEOUT_MS),
  })
  const expectedStatus = options.expect ?? 200
  if (res.status !== expectedStatus) {
    const body = await res.text().catch(() => "")
    throw new Error(`opencode ${options.method} ${pathname} returned ${res.status}: ${body.slice(0, 500)}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

main().catch((err) => {
  console.error("fatal", err)
  process.exit(1)
})
