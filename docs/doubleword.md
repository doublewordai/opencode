# Doubleword integration (experiment harness)

This fork is a workbench for [COR-362: Multi-Tier Agentic Tools — validation experiment](https://linear.app/doubleword/issue/COR-362). It progressively swaps opencode's inference layer onto four Doubleword inference paths to surface client-side tool-handling pain points.

This file documents **phase 1 (sync baseline)**. Subsequent phases will add their own documentation alongside this one.

## What's in the fork

- `opencode.json` at the repo root — registers a `doubleword` provider via `@ai-sdk/openai-compatible` pointed at `https://api.doubleword.ai/v1`, plus a primary `review` agent purpose-built for PR review.
- `packages/pr-review-shim/` (forthcoming) — a long-running webhook handler that spawns a fresh opencode server per incoming GitHub PR webhook.
- `docs/doubleword.md` — this file.

## Provider configuration

`opencode.json` registers Doubleword:

```jsonc
{
  "provider": {
    "doubleword": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Doubleword",
      "env": ["DOUBLEWORD_API_KEY"],
      "options": {
        "baseURL": "https://api.doubleword.ai/v1",
        "apiKey": "{env:DOUBLEWORD_API_KEY}"
      },
      "models": {
        "Qwen/Qwen3.5-397B-A17B-FP8": { ... }
      }
    }
  }
}
```

The `{env:DOUBLEWORD_API_KEY}` placeholder is substituted at config-load time by `ConfigVariable.substitute` (`packages/opencode/src/config/variable.ts`). Set the env var before running opencode locally:

```bash
export DOUBLEWORD_API_KEY=sk-...
opencode
```

## The `review` agent

A primary agent specialised for reading-only PR review:

- **Permissions** — `read`, `grep`, `glob`, `list`, `bash`, `webfetch` allowed; everything else denied. The agent cannot write, edit, or modify any files. `bash` is permitted so the agent can shell out to `git` and `gh` for diff fetching and PR metadata.
- **`steps: 20`** — caps the agentic loop. Without this, opencode's loop is unbounded by default (`packages/opencode/src/agent/agent.ts`), creating runaway-loop risk.
- **Model** — pinned to `doubleword/Qwen/Qwen3.5-397B-A17B-FP8`.
- **Prompt** — instructs the agent to read the PR diff via `git`/`gh`, examine relevant context, and emit a structured review markdown comment as its final response.

## Deployment shape (single server, per-request directory)

opencode's server loads workspace context per-request via the `x-opencode-directory` header (`packages/opencode/src/server/routes/instance/middleware.ts:9`). One long-running server can review PRs across different repos by passing a different directory header per request:

1. Webhook handler (`packages/pr-review-shim/`) receives a GitHub `pull_request` event
2. Clones the PR's branch into a temp workspace under `/tmp/pr-<id>`
3. POSTs to `/api/session` on the long-running opencode server with header `x-opencode-directory: /tmp/pr-<id>` to create a session bound to that workspace
4. POSTs to `/api/session/:id/message` with the same header and the review prompt; consumes the NDJSON stream
5. Extracts the final `text` part from the last assistant message
6. Posts the review back via `gh pr comment`
7. Removes the temp workspace

The opencode server itself is one persistent process. A single server handles concurrent PRs by keying on the directory header. This is the *minimum-friction* shape; for stronger isolation a customer would still want per-PR containers (so one bad PR's `bash` exec can't see another PR's checkout) — and the platform doesn't help with that lifecycle. That nuance is itself a recordable production friction for the final 4-way comparison doc ([COR-367](https://linear.app/doubleword/issue/COR-367)).

## Required env vars (phase 1)

| Variable | Used by | Notes |
|---|---|---|
| `DOUBLEWORD_API_KEY` | opencode (via `{env:...}` substitution) | Doubleword inference key. Will be rotated after the experiment. |
| `GITHUB_TOKEN` | webhook handler + agent's `bash` tool | For fetching PR data and posting review comments via `gh` |
| `OPENCODE_SERVER_PASSWORD` | opencode server / webhook handler | HTTP Basic Auth between handler and the spawned opencode server |

## Running locally

For a manual smoke test against a checked-out repo (no webhook handler yet):

```bash
cd /path/to/some/checkout
export DOUBLEWORD_API_KEY=sk-...
opencode run --agent review --model doubleword/Qwen/Qwen3.5-397B-A17B-FP8 \
  "Review the diff between origin/main and HEAD and produce a review comment."
```

(Replace `opencode run` with whatever the appropriate non-interactive entry point is — see [COR-364](https://linear.app/doubleword/issue/COR-364) for the harness work that wraps this.)

## Production friction observed (running tally)

This section is the load-bearing payload of the experiment. Every piece of friction recorded here is something that *only exists because tool execution lives client-side*. A Doubleword-hosted server-side tool loop ([Multi-Tier Agentic Tools](https://linear.app/doubleword/project/multi-tier-agentic-tools-70de986f3f32)) could in principle ship `github_review_pr` as a hosted capability with most of this concealed inside the platform.

### Phase 1 (sync baseline)

- **Bot identity setup.** Posting a review as a recognisable PR participant requires a separate bot identity — either a fresh GitHub user account that gets added as a collaborator (pollutes the org's user roster) or a GitHub App with private-key auth + installation tokens (correct pattern, but requires creating an App, generating a key, installing it on each repo, and refreshing short-lived installation tokens in code). Both flows exist *only because* the agent is hosted by us, not by GitHub. A platform tool wouldn't need any of this — Doubleword could broker the GitHub identity centrally.
- **Webhook delivery infrastructure.** To get notified of new PRs, the customer must run a publicly routable HTTPS endpoint that GitHub can reach, with HMAC-verified signature handling. We're using Cloud Run for that here. A platform-side tool loop wouldn't require the customer to deploy anything to receive triggers.
- **Per-PR working-directory lifecycle.** opencode supports per-request directories via `x-opencode-directory`, so we don't need a container per PR — but we still have to clone each PR's branch into a temp dir, manage cleanup, and serialize the side-effects (`bash` exec on file system, `gh` CLI calls). All of that is client-side bookkeeping that a hosted execution layer would handle once.
- **Tool-binary distribution.** The agent's `bash` tool needs `git` and `gh` available in the runtime image. Bundling these is straightforward in alpine but a customer must own the supply chain (CVE patching, version pinning, image rebuilds) for every tool the agent uses. Server-side tools centralise that responsibility.

(Phases 2–4 will append their own friction findings to this section.)

## What this phase tests

Sync chat-completions against Doubleword. Establishes the baseline for the four-way comparison:

| Phase | Inference path | Linear |
|---|---|---|
| 1 (this) | Sync chat-completions, realtime tier | [COR-364](https://linear.app/doubleword/issue/COR-364) |
| 2 | `createDoublewordAsync` (autobatcher, flex tier, client-side batching) | [COR-365](https://linear.app/doubleword/issue/COR-365) |
| 3 | Open Responses API + `service_tier=flex` (long-held connection) | [COR-366](https://linear.app/doubleword/issue/COR-366) |
| 4 | Open Responses API + `service_tier=flex` + `background=true` (poll) | [COR-367](https://linear.app/doubleword/issue/COR-367) |
