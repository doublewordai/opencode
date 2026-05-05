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
  REVIEW_MODEL_ID: process.env.REVIEW_MODEL_ID ?? "Qwen/Qwen3.5-397B-A17B-FP8",
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

type Poster = (text: string) => Promise<void>

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
    const reviewText = await runReviewSession({ directory: workdir, opencodeServerUrl, ...input })
    if (!reviewText) {
      console.error(`[${tag}] no review text returned from opencode`)
      return
    }
    await post(reviewText)
    console.log(`[${tag}] review delivered`)
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch((err) => console.error(`[${tag}] cleanup failed`, err))
  }
}

function postAsReview(input: ReviewInput): Poster {
  return async (text) => {
    await octokit.rest.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      event: "COMMENT",
      body: text,
    })
  }
}

function postAsLog(input: ReviewInput): Poster {
  const tag = tagOf(input)
  return async (text) => {
    console.log(`\n=== [${tag}] review (log-only) ===\n${text}\n=== end review ===\n`)
  }
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

async function runReviewSession(input: {
  directory: string
  opencodeServerUrl: string
  prTitle: string
  prNumber: number
  baseBranch: string
}): Promise<string | null> {
  // Sessions are bare; agent + model are bound per-message via the v1
  // /session/:id/message endpoint, which returns the assistant message
  // synchronously with all its parts attached.
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

  const reply = await opencode<{
    parts?: Array<{ type: string; text?: string }>
    success?: boolean
    error?: unknown
  }>(input.opencodeServerUrl, `/session/${session.id}/message`, {
    method: "POST",
    directory: input.directory,
    body: {
      agent: env.REVIEW_AGENT,
      model: { providerID: env.REVIEW_MODEL_PROVIDER, modelID: env.REVIEW_MODEL_ID },
      parts: [{ type: "text", text: promptText }],
    },
  })

  if (!reply.parts) {
    throw new Error(`opencode session returned no parts; envelope: ${JSON.stringify(reply).slice(0, 500)}`)
  }
  return [...reply.parts].reverse().find((p) => p.type === "text")?.text ?? null
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
