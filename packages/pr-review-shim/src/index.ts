/**
 * PR review webhook shim for the COR-364 experiment harness.
 *
 * Receives a GitHub pull_request webhook, clones the PR branch into a temp
 * worktree, asks a long-running opencode server to run the `review` agent
 * against that worktree (via the `x-opencode-directory` header), then posts
 * the resulting review back to the PR as a comment.
 *
 * One opencode server, many concurrent reviews — see docs/doubleword.md for
 * the deployment shape and rationale.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Octokit } from "@octokit/rest"

const env = {
  DOUBLEWORD_API_KEY: requireEnv("DOUBLEWORD_API_KEY"),
  GITHUB_TOKEN: requireEnv("GITHUB_TOKEN"),
  GITHUB_WEBHOOK_SECRET: requireEnv("GITHUB_WEBHOOK_SECRET"),
  OPENCODE_SERVER_URL: process.env.OPENCODE_SERVER_URL ?? "http://localhost:14123",
  OPENCODE_SERVER_PASSWORD: requireEnv("OPENCODE_SERVER_PASSWORD"),
  PORT: Number(process.env.PORT ?? 8080),
  REVIEW_AGENT: process.env.REVIEW_AGENT ?? "review",
  REVIEW_MODEL_PROVIDER: process.env.REVIEW_MODEL_PROVIDER ?? "doubleword",
  REVIEW_MODEL_ID: process.env.REVIEW_MODEL_ID ?? "Qwen/Qwen3.5-397B-A17B-FP8",
  BASE_BRANCH: process.env.BASE_BRANCH ?? "main",
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

const octokit = new Octokit({ auth: env.GITHUB_TOKEN })

const opencodeAuthHeader = "Basic " + Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")

type PullRequestEvent = {
  action: string
  pull_request: {
    number: number
    head: { ref: string; sha: string; repo: { clone_url: string; full_name: string } }
    base: { ref: string }
    title: string
    html_url: string
  }
  repository: { full_name: string; clone_url: string; owner: { login: string }; name: string }
}

const TRIGGER_ACTIONS = new Set(["opened", "synchronize", "reopened"])

const server = Bun.serve({
  port: env.PORT,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/healthz") return new Response("ok")
    if (url.pathname !== "/webhook" || req.method !== "POST") return new Response("not found", { status: 404 })

    const body = await req.text()
    const sigHeader = req.headers.get("x-hub-signature-256")
    if (!sigHeader || !verifySignature(body, sigHeader)) return new Response("invalid signature", { status: 401 })

    const eventType = req.headers.get("x-github-event")
    if (eventType !== "pull_request") return new Response("ignored", { status: 200 })

    const event = JSON.parse(body) as PullRequestEvent
    if (!TRIGGER_ACTIONS.has(event.action)) return new Response("ignored", { status: 200 })

    // Fire-and-forget — the webhook should return quickly so GitHub doesn't retry.
    runReview(event).catch((err) => console.error("review failed", { pr: event.pull_request.number, err }))
    return new Response("queued", { status: 202 })
  },
})

console.log(`pr-review-shim listening on http://localhost:${server.port}`)

function verifySignature(body: string, header: string): boolean {
  const expected = "sha256=" + createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")
  if (header.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected))
}

async function runReview(event: PullRequestEvent): Promise<void> {
  const pr = event.pull_request
  const owner = event.repository.owner.login
  const repo = event.repository.name
  const tag = `pr-${repo}-${pr.number}`
  const workdir = await mkdtemp(path.join(os.tmpdir(), `${tag}-`))
  console.log(`[${tag}] starting review at ${workdir}`)

  try {
    await cloneRepo({
      cloneUrl: authedCloneUrl(event.repository.clone_url),
      ref: pr.head.ref,
      baseRef: pr.base.ref,
      cwd: workdir,
    })

    const reviewText = await runReviewSession({
      directory: workdir,
      prTitle: pr.title,
      prNumber: pr.number,
      baseBranch: pr.base.ref,
    })

    if (!reviewText) {
      console.error(`[${tag}] no review text returned from opencode`)
      return
    }

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: reviewText,
    })
    console.log(`[${tag}] posted review`)
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch((err) => console.error(`[${tag}] cleanup failed`, err))
  }
}

function authedCloneUrl(cloneUrl: string): string {
  // GitHub clone URLs are https://github.com/<owner>/<repo>.git — inject the token for private repo access.
  const url = new URL(cloneUrl)
  url.username = "x-access-token"
  url.password = env.GITHUB_TOKEN
  return url.toString()
}

async function cloneRepo(input: { cloneUrl: string; ref: string; baseRef: string; cwd: string }): Promise<void> {
  await runCmd("git", ["clone", "--no-tags", "--depth=50", input.cloneUrl, "."], input.cwd)
  await runCmd("git", ["fetch", "origin", `${input.baseRef}:${input.baseRef}`], input.cwd)
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
  prTitle: string
  prNumber: number
  baseBranch: string
}): Promise<string | null> {
  const session = await opencode<{ id: string }>("/session", {
    method: "POST",
    directory: input.directory,
    body: {
      title: `PR #${input.prNumber} review`,
      agent: env.REVIEW_AGENT,
      model: { providerID: env.REVIEW_MODEL_PROVIDER, id: env.REVIEW_MODEL_ID },
    },
  })

  const promptText = [
    `Review pull request #${input.prNumber}: ${input.prTitle}.`,
    `The base branch is \`${input.baseBranch}\`. The PR's HEAD is checked out at the current working directory.`,
    `Run \`git log ${input.baseBranch}..HEAD --stat\` and \`git diff ${input.baseBranch}...HEAD\` to find the change set, read relevant files for context, and produce a complete review comment as your final response per your system instructions.`,
  ].join("\n\n")

  await opencode(`/api/session/${session.id}/prompt`, {
    method: "POST",
    directory: input.directory,
    body: { prompt: { text: promptText } },
  })
  await opencode(`/api/session/${session.id}/wait`, {
    method: "POST",
    directory: input.directory,
    body: {},
    expect: 204,
  })

  const messages = await opencode<{ items: Array<{ role: string; parts: Array<{ type: string; text?: string }> }> }>(
    `/api/session/${session.id}/message`,
    { method: "GET", directory: input.directory },
  )

  for (let i = messages.items.length - 1; i >= 0; i--) {
    const msg = messages.items[i]
    if (!msg || msg.role !== "assistant") continue
    const text = [...msg.parts].reverse().find((p) => p.type === "text")?.text
    if (text) return text
  }
  return null
}

async function opencode<T = unknown>(
  pathname: string,
  options: { method: string; directory: string; body?: unknown; expect?: number },
): Promise<T> {
  const res = await fetch(`${env.OPENCODE_SERVER_URL}${pathname}`, {
    method: options.method,
    headers: {
      "content-type": "application/json",
      authorization: opencodeAuthHeader,
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
