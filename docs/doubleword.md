# Doubleword integration (experiment harness)

This fork is a workbench for [COR-362: Multi-Tier Agentic Tools — validation experiment](https://linear.app/doubleword/issue/COR-362). It progressively swaps opencode's inference layer onto four Doubleword inference paths to surface client-side tool-handling pain points. The friction we record across all four phases is the load-bearing evidence for the parent project's go/no-go.

This file documents **phase 1 (sync baseline)**. Subsequent phases append their own sections (and provider config) below the phase-1 content; nothing in this file should be deleted as work moves forward.

---

## ⚡ For a remote agent picking this up cold

If you're new to this experiment, read in this order:

1. [COR-362](https://linear.app/doubleword/issue/COR-362) — overall goal and four-phase plan
2. [COR-363](https://linear.app/doubleword/issue/COR-363) — phase 0 (mock-product selection); explains why opencode was chosen over pr-agent / aider / Goose
3. [COR-364](https://linear.app/doubleword/issue/COR-364) — phase 1 (this doc) — sync baseline ✅ Done
4. **This doc** — deployment runbook + friction observed + test methodology
5. [COR-365](https://linear.app/doubleword/issue/COR-365) — phase 2 (autobatcher) — next up
6. [COR-366](https://linear.app/doubleword/issue/COR-366), [COR-367](https://linear.app/doubleword/issue/COR-367) — phases 3 & 4

All operational state is in three places: this file, the Linear issues, and the Cloud Run env vars on the `pr-review-harness` service in `tech-426212/europe-west4`. There is no other state of record.

---

## Current state (phase 1)

| | |
|---|---|
| **Status** | ✅ Functional — bot review delivered on test PR doublewordai/control-layer#1047 in 72 s, scored 13/24 direct hits + 3 partials + 3 bonus catches against ground truth |
| **Deployed at** | `https://pr-review-harness-481447246028.europe-west4.run.app` |
| **Webhook URL** | `https://pr-review-harness-481447246028.europe-west4.run.app/webhook` |
| **GCP project / region** | `tech-426212` / `europe-west4` |
| **Cloud Run service** | `pr-review-harness` |
| **Artifact Registry** | `europe-west4-docker.pkg.dev/tech-426212/pr-review-harness/harness:phase-1` |
| **Service account** | `pr-review-harness@tech-426212.iam.gserviceaccount.com` (dedicated) |
| **Branch** | `experiment/phase-1-sync-provider` on [doublewordai/opencode](https://github.com/doublewordai/opencode/tree/experiment/phase-1-sync-provider) |
| **GitHub App** | "Doubleword PR Review", App ID `3610877`, installed on `doublewordai` org, posts as `doubleword-code[bot]` |
| **Test PR** | [doublewordai/control-layer#1047](https://github.com/doublewordai/control-layer/pull/1047) — keep open as the long-running test PR; close+reopen to retrigger |

---

## What's in the fork

- **`opencode.json`** at the repo root — registers the `doubleword` provider via `@ai-sdk/openai-compatible` pointed at `https://api.doubleword.ai/v1`, plus a primary `review` agent purpose-built for read-only PR review.
- **`packages/pr-review-shim/`** — the Bun-compiled webhook handler. Self-supervises `opencode serve` as a child process; receives GitHub webhooks; clones the PR's branch into `/tmp/<sanitized-tag>-XXXXXX`; calls the long-running opencode server with `x-opencode-directory: <workdir>`; posts the agent's review back via `pulls.createReview` (event=COMMENT) using a GitHub App installation token.
- **`packages/pr-review-shim/Dockerfile`** + **`docker-compose.yml`** — single-container image for Cloud Run; two-container compose for local dev.
- **`docs/doubleword.md`** — this file.

---

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

The `{env:DOUBLEWORD_API_KEY}` placeholder is substituted at config-load time by `ConfigVariable.substitute` (`packages/opencode/src/config/variable.ts`).

**Important:** opencode loads provider + agent config relative to the *workspace* directory (the `x-opencode-directory` header value), not the server's startup cwd. The shim copies `/app/opencode.json` into each PR worktree before kicking off the session — see `runReview` in `packages/pr-review-shim/src/index.ts`. If you change `opencode.json` and rebuild the image, the new config takes effect on the next deploy automatically (it's `COPY`'d into `/app/opencode.json` at image build time).

---

## The `review` agent

A primary agent specialised for read-only PR review:

- **Permissions** — `read`, `grep`, `glob`, `list`, `bash`, `webfetch` allowed; everything else denied. Cannot write, edit, or modify any files. `bash` is permitted so the agent can shell out to `git` for diff fetching.
- **`steps: 20`** — caps the agentic loop. Without this, opencode's loop is unbounded by default; runaway-loop risk.
- **Model** — env-driven via `REVIEW_MODEL_ID` (set on the Cloud Run service). `opencode.json` registers the model as `{env:REVIEW_MODEL_ID}` and the agent's `model` field is `doubleword/{env:REVIEW_MODEL_ID}` (substituted at config-load time by `ConfigVariable.substitute`, which works inside JSON object keys because it operates on raw text before parsing). Doubleword becomes the source of truth for which models exist; its 404 is the validation, not the opencode-side registry.
- **Prompt** — instructs the agent to read the diff via `git log <base>..HEAD` + `git diff <base>...HEAD`, examine relevant context, and emit a structured review markdown comment as the final response. The image deliberately ships *without* `gh` CLI (it was the source of all CVEs in the first vuln scan and isn't actually used).

---

## Deployment shape (single server, per-request directory)

opencode's server loads workspace context per-request via the `x-opencode-directory` header (`packages/opencode/src/server/routes/instance/middleware.ts:9`). One long-running server can review PRs across different repos by passing a different directory header per request:

1. Webhook handler receives a GitHub `pull_request` event
2. Verifies the HMAC signature against `GITHUB_WEBHOOK_SECRET`
3. Returns `202` to GitHub immediately (so the webhook doesn't retry); the review work runs in the background
4. Clones the PR's branch into `/tmp/<sanitized>-XXXXXX` (the tag has slashes scrubbed to `-` because `mkdtemp` does not create intermediate dirs)
5. Copies `/app/opencode.json` into the workdir so the `review` agent + Doubleword provider are visible
6. Mints a GitHub App installation token, then `git clone` (depth=500, enough for the merge-base of typical PRs to be reachable), then `git fetch origin <base>` + `git fetch origin <head-ref>` + `git checkout FETCH_HEAD`
7. POSTs to `/session` on the long-running opencode server with `x-opencode-directory: <workdir>` to create a session
8. POSTs to `/session/:id/prompt_async` with the same header, body `{ agent: "review", model: { providerID, modelID }, parts: [{ type: "text", text: <prompt> }] }`. This forks the agent loop into a background fiber on the server and returns `204` immediately. The shim used to use the synchronous `POST /session/:id/message` (v1) here, but that endpoint holds the connection open for the entire loop and Bun's HTTP client has an internal ~5-min idle-read timeout we can't override — see the friction tally for the full failure mode.
9. Polls `GET /session/:id/message` every `REVIEW_POLL_INTERVAL_MS` (default 5s) for an assistant message with `info.time.completed` set, bounded by `REVIEW_TIMEOUT_MS` (default 30 min). Extracts the final `text` part from `parts.findLast(p => p.type === "text")`. The session is fresh per PR so there is at most one assistant message to inspect.
10. Posts the review back via `octokit.rest.pulls.createReview({ event: "COMMENT", body: text })` using a fresh installation token
11. Removes the temp workspace

The opencode server itself is one persistent process inside the same container as the shim — `pr-review-shim` spawns `opencode serve` as a child via `node:child_process.spawn` and forwards `SIGTERM`/`SIGINT` to it. Single-container shape because Cloud Run's networking model makes the sidecar pattern more friction than it's worth for an experiment.

For *production* isolation a customer would still want per-PR containers (so one bad PR's `bash` exec can't see another PR's checkout) — and the platform doesn't help with that lifecycle. That nuance is part of the friction tally.

---

## Required env vars (phase 1)

All set on the Cloud Run `pr-review-harness` service. View / update via:

```bash
gcloud run services describe pr-review-harness --region=europe-west4 --format=yaml | grep -A2 -E '\- name:'
gcloud run services update pr-review-harness --region=europe-west4 --update-env-vars=KEY=VALUE
```

| Variable | Used by | Notes |
|---|---|---|
| `DOUBLEWORD_API_KEY` | opencode (via `{env:...}` substitution) | Doubleword inference key. Currently set; **rotate after the experiment**. |
| `GITHUB_APP_ID` | shim (`@octokit/auth-app`) | `3610877` — the Doubleword PR Review GitHub App |
| `GITHUB_INSTALLATION_ID` | shim | `129746304` — the install on `doublewordai` org |
| `GITHUB_PRIVATE_KEY` | shim | RSA PEM of the App's private key. **Rotate after the experiment** — was once shared in chat. |
| `GITHUB_WEBHOOK_SECRET` | shim | 32 hex bytes; matches the App's webhook secret |
| `OPENCODE_SERVER_PASSWORD` | shim ↔ opencode | HTTP Basic Auth between the shim's HTTP client and the spawned opencode server |
| `OPENCODE_BIN` | shim | `/usr/local/bin/opencode` — path to the bundled binary |
| `REVIEW_MODEL_ID` | shim + opencode.json | The Doubleword model to run. Required. opencode.json registers the model registry as `{env:REVIEW_MODEL_ID}` and the shim sends it as the per-message `model.modelID` override, so the two stay aligned automatically. |
| `REVIEW_AGENT` | shim (optional) | Defaults to `review`. The agent name to invoke on the opencode session. |
| `OPENCODE_FETCH_TIMEOUT_MS` | shim (optional) | Defaults to 30s. Per-HTTP-call timeout for shim → opencode. Each call is now trivial (POST returns 204; GET messages returns immediately) so 30s is plenty. |
| `REVIEW_TIMEOUT_MS` | shim (optional) | Defaults to 30 min. Overall ceiling on the agent loop. Past this the shim gives up polling. |
| `REVIEW_POLL_INTERVAL_MS` | shim (optional) | Defaults to 5s. Cadence for polling `GET /session/:id/message` waiting for the assistant reply to complete. |
| `WATCHED_REPOS` | shim (optional) | Comma-separated `owner/repo` list for stateless daily polling. Empty by default. Polled PRs get reviews logged to stdout, not posted. |
| `POLL_INTERVAL_MS` | shim (optional) | Defaults to 24 h. Determines both the polling cadence and the "PRs created in the last N ms" filter. |

---

## Deployment runbook

### Build + push + redeploy after a code change

```bash
# from /Users/sebringrose/temp/DW/opencode (or wherever the fork is checked out):
cd packages/opencode && bun run build && cd ../..
cd packages/pr-review-shim && bun run build && cd ../..
docker buildx build --platform linux/amd64 \
  -f packages/pr-review-shim/Dockerfile \
  -t pr-review-harness:phase-1 --load .
IMAGE=europe-west4-docker.pkg.dev/tech-426212/pr-review-harness/harness:phase-1
docker tag pr-review-harness:phase-1 $IMAGE
docker push $IMAGE
gcloud run services update pr-review-harness --region=europe-west4 --image=$IMAGE
```

### Re-trigger the bot on test PR #1047

```bash
gh pr close 1047 --repo doublewordai/control-layer && \
gh pr reopen 1047 --repo doublewordai/control-layer
```

(Closing then reopening sends a `closed` and `reopened` webhook. The shim ignores `closed` and triggers on `reopened`.)

### Watch logs

```bash
# one-shot:
gcloud run services logs read pr-review-harness --region=europe-west4 --limit=50

# pseudo-tail (works without alpha components):
while true; do clear; gcloud run services logs read pr-review-harness --region=europe-west4 --limit=30; sleep 5; done

# or in the console:
# https://console.cloud.google.com/run/detail/europe-west4/pr-review-harness/logs?project=tech-426212
```

### Inspect the Cloud Run config

```bash
gcloud run services describe pr-review-harness --region=europe-west4
```

Notable settings: `--no-cpu-throttling` (must stay; otherwise post-202 background work is throttled to ~0 and the instance gets reaped mid-review), `--min-instances=1 --max-instances=1`, `--cpu=2 --memory=2Gi`, `--timeout=3600`, execution environment `gen2`.

### Rotate the GitHub App private key

1. Go to the App settings → Generate a new private key (.pem)
2. Update Cloud Run env: `gcloud run services update pr-review-harness --region=europe-west4 --update-env-vars=GITHUB_PRIVATE_KEY="<contents>"` (multi-line — easier to use `--env-vars-file=path-to-yaml`)
3. Revoke the old key in the App settings

### Rotate the Doubleword API key

1. Mint a new key in the Doubleword admin console
2. `gcloud run services update pr-review-harness --region=europe-west4 --update-env-vars=DOUBLEWORD_API_KEY=sk-...`
3. Revoke the old one

### Switch to a new model or agent for testing

Edit `opencode.json` at the fork root (provider `models` map and/or `agent.review.model`), commit, rebuild + redeploy. Or set `REVIEW_MODEL_ID` / `REVIEW_AGENT` env on Cloud Run for ad-hoc overrides without rebuilding.

---

## Test methodology

We validate the bot end-to-end by **planting bad-practice patterns in a test PR with a "ground truth" of the issues we expect a competent reviewer to catch**, then comparing the bot's review against ground truth.

### The test PR

[doublewordai/control-layer#1047](https://github.com/doublewordai/control-layer/pull/1047) — branch `experiment/pr-review-bot-test`. Adds two unwired-up files:

- `dwctl/src/api/handlers/system_info.rs` — backend handler with 13 planted issues (security exposure, missing auth, hardcoded secret, missing tracing, missing utoipa, unused route, multiple `unwrap` panics, etc.)
- `dashboard/src/components/features/user-notes/UserNotes/UserNotes.tsx` — frontend component with 11 planted issues (XSS via `dangerouslySetInnerHTML`, hardcoded admin token, `useEffect` with no deps, missing interval cleanup, race conditions, hardcoded API URL, etc.)

**The PR is intentional — DO NOT MERGE.** Keep it open as a long-running fixture for retesting after harness changes. Close+reopen to retrigger the bot.

### Ground truth

The full list of planted issues with severity classification lives at `/tmp/pr-review-bot-truth.md` (local-only, not committed because it's the answer key). To regenerate it on a fresh machine, you'd:

1. Read the diff of PR #1047 vs `doublewordai/control-layer:main`
2. Identify each bad-practice pattern with file:line + severity (Blocking / Non-blocking / Nit)
3. Score the bot's review against your list

The phase-1 ground truth had **24 issues** (13 backend + 11 frontend), of which **7 were Blocking-severity** (hardcoded admin token in two places, sensitive data in API responses, sensitive data in logs, XSS twice, hardcoded admin token in DELETE).

### Scoring rubric

For each ground-truth issue, mark whether the bot's review:

- **HIT** — explicitly mentioned with correct severity
- **PARTIAL** — mentioned but mis-classified
- **MISS** — not mentioned

Track bonus catches (real issues the bot found that weren't in your ground truth) and false positives separately.

---

## Phase 1 results

The bot's review of PR #1047 (run on Cloud Run revision `pr-review-harness-00008-zg4`):

| Metric | Score |
|---|---|
| Direct hits | **13 / 24** (54%) |
| Hits + partials | **16 / 24** (67%) |
| Of the 7 Blocking-severity issues | **6 / 7** hit or partial (86%) |
| False positives | 1 |
| Bonus catches | 3 |
| End-to-end latency | 72 s |

**The bot:**
- Caught every frontend security issue (XSS twice, hardcoded admin token, hardcoded API URL)
- Caught 3 of 4 backend security issues directly + the 4th as a Nit
- Caught all the convention violations (missing tracing, missing utoipa, missing dependency array, missing cleanup)
- Found a real bug we didn't even plant (the `uptime_seconds` field returned seconds-since-1970 rather than actual uptime)
- Made a clear "do not merge until resolved" recommendation
- Missed mostly subtle correctness issues that need deeper data-flow analysis (per-render env reads, stale closures, optimistic UI rollback)

**This is a strong pass signal for phase 1.** The agent loop on Doubleword's sync chat-completions inference produces actionable, structured PR reviews comparable to GitHub Copilot. Phases 2–4 will use this as the comparison baseline.

### Phase 1 results — Copilot-pattern + async refactor + DeepSeek-V4-Flash

After the second-iteration changes — research-heavy prompt, summary + inline-comment output (Copilot pattern), `prompt_async` + polling, `REVIEW_MODEL_ID` env-driven — we re-ran on `pr-review-harness-00013-rxn` with `REVIEW_MODEL_ID=deepseek-ai/DeepSeek-V4-Flash`:

| Metric | Score |
|---|---|
| Direct hits | **11 / 24** (46%) |
| Hits + partials | **15 / 24** (63%) |
| Of the 7 Blocking-severity issues | **6 / 7** hit or partial (86%) |
| False positives | 0 |
| Bonus catches | 3 |
| Inline comments posted | 16 |
| End-to-end latency | 124 s (2 min 4 s) |

**Per-issue scoring** (HIT = explicit + correct severity, PARTIAL = mentioned but mis-classified or different angle, MISS = not mentioned):

Backend (`system_info.rs`): B1 HIT (summary general-findings: "must be behind authentication/authorization"), B2 MISS, B3 HIT, B4 HIT, B5 PARTIAL (severity downgraded to Non-blocking), B6 MISS (the unwrap-on-clock-skew angle was missed; the bot caught a *different* bug at the same line — see bonus catches), B7 MISS, B8 HIT, B9 MISS (the `println!` was flagged for leaking the token but not separately for violating the tracing convention), B10 PARTIAL (flagged as "ADMIN_TOKEN not standard config" — related but not the per-request env-read angle), B11 MISS, B12 HIT, B13 HIT (summary general-findings: "not yet registered in the router"). **6 hits + 2 partials + 5 misses out of 13.**

Frontend (`UserNotes.tsx`): F1 HIT (both XSS sites — `:46` and `:56` — flagged independently), F2 HIT, F3 PARTIAL (severity upgraded to Blocking), F4 PARTIAL (severity upgraded to Blocking), F5 MISS, F6 HIT, F7 HIT, F8 MISS, F9 MISS, F10 MISS, F11 HIT. **5 hits + 2 partials + 4 misses out of 11.**

**Bonus catches (3):**

1. **`uptime_seconds` semantic bug** — The bot flagged that `SystemTime::now().duration_since(UNIX_EPOCH)` returns *seconds since the Unix epoch*, not process uptime. This is a different angle on the same line as ground-truth B6 (which targeted the `unwrap()` panic risk) and a real correctness bug not in our ground truth. The Qwen baseline also caught this independently.
2. **`debug_payload` field duplication** — Pointed out that `debug_payload.rev` / `host_user` duplicate top-level fields (`version` / `host_user`).
3. **`ADMIN_TOKEN` naming convention drift** — Beyond the per-request env-read angle (B10), the bot used a `grep` to discover that `ADMIN_TOKEN` doesn't appear elsewhere in the codebase and that the project's secret-management convention is `DWCTL_*` env vars routed through `Config.secret_key`. This is the kind of architectural insight the research-heavy prompt is *supposed* to produce — and would not have surfaced from the diff alone.

**What the second iteration won:**

- **Zero false positives** (vs. 1 in the original Qwen run). Every inline comment is a real issue.
- **Research grounded in the codebase, not generic best-practice boilerplate.** The bot's research notes cite specific grep counts: *"Every single handler in the codebase uses `#[tracing::instrument(skip_all)]` (147 matches)"*, *"`#[utoipa::path(...)]` (143 matches)"*, *"the codebase stores its security secret via `config.secret_key` (read from `DWCTL_SECRET_KEY` env var / `config.yaml`). The env var `ADMIN_TOKEN` is not referenced anywhere else"*. That's the research-heavy prompt + tool loop earning its keep.
- **Inline comments anchored to specific lines.** Reviewers see findings exactly where the issue lives — the GitHub Copilot review pattern. The Qwen baseline posted a single big summary comment.
- **All 7 Blocking issues either hit or partial.** Same 6/7 ratio as the Qwen baseline; the only Blocking miss is B2 (hardcoded fallback secret) in both runs.

**What it lost:**

- Slight regression on direct hits (11/24 vs. 13/24). The Non-blocking correctness misses cluster in the frontend (F5 race, F8 SSR-unsafe localStorage, F9 `(d as any)` casts, F10 fresh-function-per-render) and the backend (B7 unwrap, B9 println-vs-tracing convention, B11 `_state` nit). These are subtler and the inline-only output format may have caused the bot to omit findings that didn't have an obvious anchor line. The Qwen baseline got several of these in its summary prose.
- Latency 124s vs 72s — slower than the Qwen baseline despite a smaller / faster-tier model, because the research-heavy prompt drives more tool calls per review.

**Net read:** the inline-comment + research-heavy pattern produces a *visibly higher-quality* review per finding (grounded, not boilerplate, posted Copilot-style on the right lines) at the cost of a few subtle Non-blocking misses. For real-PR use, we'd take this trade. Phases 2–4 will compare *both* iterations against the same ground truth.

---

## Production friction observed (running tally)

This section is the load-bearing payload of the experiment. Every piece of friction recorded here is something that *only exists because tool execution lives client-side*. A Doubleword-hosted server-side tool loop ([Multi-Tier Agentic Tools](https://linear.app/doubleword/project/multi-tier-agentic-tools-70de986f3f32)) could in principle ship `github_review_pr` as a hosted capability with most of this concealed inside the platform.

### Phase 1 (sync baseline) — design-level friction

- **Bot identity setup.** Posting a review as a recognisable PR participant requires a separate bot identity — either a fresh GitHub user account that gets added as a collaborator (pollutes the org's user roster) or a GitHub App with private-key auth + installation tokens (correct pattern, but requires creating an App, generating a key, installing it on each repo, and refreshing short-lived installation tokens in code). Both flows exist *only because* the agent is hosted by us, not by GitHub. A platform tool wouldn't need any of this — Doubleword could broker the GitHub identity centrally.
- **Webhook delivery infrastructure.** To get notified of new PRs, the customer must run a publicly routable HTTPS endpoint that GitHub can reach, with HMAC-verified signature handling. We're using Cloud Run for that here. A platform-side tool loop wouldn't require the customer to deploy anything to receive triggers.
- **Per-PR working-directory lifecycle.** opencode supports per-request directories via `x-opencode-directory`, so we don't need a container per PR — but we still have to clone each PR's branch into a temp dir, manage cleanup, and serialise the side-effects (`bash` exec on file system). All of that is client-side bookkeeping that a hosted execution layer would handle once.
- **Tool-binary distribution.** The agent's `bash` tool needs `git` available in the runtime image. Bundling these is straightforward in alpine but a customer must own the supply chain (CVE patching, version pinning, image rebuilds) for every tool the agent uses. (We learned this the hard way: the alpine `github-cli` package shipped 15 statically-linked Go-dep CVEs that we only resolved by removing it from the image.) Server-side tools centralise that responsibility.
- **Cloud-side IAM gymnastics for public ingress.** Webhooks are unauthenticated POSTs by protocol — receiving them requires a publicly invokable HTTPS endpoint. On Cloud Run, exposing the service to `allUsers` requires `run.services.setIamPolicy`, which most engineers won't have on a SOC 2-scoped project. Resolving this required pulling in someone with project IAM admin to make a one-line change. A platform-side tool loop wouldn't impose this on the customer at all — the inbound trigger is internal to Doubleword's infrastructure.
- **Compliance posture proxying.** Even with the right infra controls in place (HMAC-validated webhook, dedicated service account, bounded resources, AR vulnerability scanning), the *act of deploying* a public webhook receiver into a SOC 2-scoped project pushed change-management considerations onto the customer that wouldn't exist at all if the agent ran on Doubleword. Customers building agentic products today inherit our security posture *and* their own.

### Phase 1 (sync baseline) — implementation friction surfaced by the dogfood test

These are first-time-only mistakes, but each is a representative customer footgun:

- **`mkdtemp` ENOENT on slashed tags.** Using `${owner}/${repo}#${prNumber}` as the temp-dir prefix failed because `mkdtemp` does not create intermediate directories. Sanitised to `[^a-z0-9-]/gi → -`. Customer-side code has to handle filesystem-safe naming; platform-side tools wouldn't expose this surface to the customer at all.
- **`git fetch origin <base>:<base>` collision.** When the PR's base branch is the repo's default branch (which the clone already checks out as a local branch), git refuses to fetch into it. Dropped the local-dst part of the refspec so it just updates `origin/<base>`. Customer-side cloning + git plumbing is the customer's problem to get right.
- **Per-workspace agent configuration.** opencode loads `agent` + `provider` config relative to the *workspace* directory passed via the `x-opencode-directory` header — not the server's startup cwd. The first review attempt failed with `Agent not found: "review". Available agents: build, explore, general, plan` because the cloned PR worktree didn't carry an `opencode.json`. Fix: copy `/app/opencode.json` into each cloned workdir before kicking off the session. This is a class of "agent framework configuration leaks across multiple file system locations" friction that a hosted tool loop avoids entirely.
- **Cloud Run CPU throttling reaping mid-review.** Default Cloud Run only allocates CPU during request handling. Our shim returns `202` to GitHub immediately so the webhook doesn't retry, then runs the review work in the background — but with throttled CPU, that background work crawls, and Cloud Run reaps the instance as "idle" after ~3 minutes. The fix is `--no-cpu-throttling` (always-allocated CPU), which is more expensive. A platform-side tool loop running on Doubleword's infrastructure would have the right execution model for long-running work by default; customers paying Cloud Run's premium for "background work that runs at full speed" is a hidden tax on the client-side pattern.
- **Large models can't finish a multi-tool-call review on the realtime tier.** With the research-heavy prompt and `steps: 100`, swapping the model to `moonshotai/Kimi-K2.6` (a much larger model than the Qwen baseline) produced an agent loop that ran for **>30 minutes without converging** even when every request went through the lowest-latency path Doubleword exposes — synchronous chat-completions on the realtime/priority tier, no batching, no flex routing, no background mode. Polling logs showed the session steadily accumulating messages (16 → 19 → 21 → 23 over half an hour) at ~78s per turn average; throughput slowed in the back half as context grew, and the agent never reached a "stop, write the summary" terminal. Two failure modes are tangled here: (1) **per-step latency** — large models are slow per token, and an agentic loop multiplies that latency by the step count; (2) **no early-termination signal** — the prompt asks for many tool loops, the model dutifully keeps researching, and there is no client-managed budget that says "you've gathered enough evidence — finalise". Both are *only visible because tool execution lives client-side*. A hosted Doubleword tool loop would (a) absorb per-step latency behind the platform's batching / scheduling rather than blocking a customer's webhook handler, and (b) expose declarative budgets (per-tool, per-call, total cost ceiling) that an agent could be configured against without the customer building an early-stop heuristic from scratch. Mitigation in this experiment: dropped to a faster model (`deepseek-ai/DeepSeek-V4-Flash`), which converged in 2 min 4 s — but the cost/quality dial *should* be a platform knob, not a customer-side model swap.
- **HTTP idle-read timeouts kill long agent loops.** opencode's v1 `POST /session/:id/message` endpoint holds the HTTP connection open for the *entire* agentic loop and emits zero bytes until the loop completes. Bun's HTTP client has an internal ~5-min idle-read timeout (a `DOMException TimeoutError` fires at ~285s) that `AbortSignal.timeout(...)` can't override — they're independent timers. The phase-1 baseline never tripped this because Qwen + `steps:20` + a thin prompt converged in 72s; once we swapped to a slower model, raised the steps cap, and added a research-mandate prompt that drives many tool loops, total wall-time blew past the cap and the connection was killed every time. Fix: switch the shim to opencode's `prompt_async` endpoint (forks the loop into a background fiber, returns 204 immediately) and poll `GET /session/:id/message` for the assistant message's `time.completed`. Now no individual HTTP call is held open for long, so neither Bun's nor any intermediate proxy's idle cap matters. **This is exactly the kind of failure mode a server-side tool loop would never expose to a customer** — the entire "synchronous fetch held open for the duration of a multi-minute agent loop" pattern is a client-side concern. A hosted tool execution layer would absorb the duration of the loop internally and surface it as durable, observable steps via the Responses API (which is what phases 3 + 4 test for the inference path).

(Phases 2–4 will append their own friction findings to this section.)

---

## Deployed compliance posture (phase 1)

Recorded for audit trail. The phase-1 Cloud Run service `pr-review-harness` in `tech-426212/europe-west4` was deployed with:

- **Dedicated service account** `pr-review-harness@tech-426212.iam.gserviceaccount.com` (not the default compute SA), no IAM bindings beyond what Cloud Run requires for its own runtime
- **Public ingress** with `allUsers/run.invoker` — granted via change-managed action by an IAM admin. The compensating control is application-level HMAC-SHA256 verification on the only public endpoint (`/webhook`)
- **Resource bounds** — `min-instances=1 max-instances=1 cpu=2 memory=2Gi --no-cpu-throttling`, single-instance for predictable behaviour and bounded blast radius
- **TLS** — terminated at the Cloud Run frontend on `*.run.app` (mandatory)
- **Image** — pulled from a private Artifact Registry repo (`pr-review-harness/harness:phase-1`) with vulnerability scanning enabled; current digest has zero CVEs (achieved by removing the unused `github-cli` package which carried 15 statically-linked Go-dep CVEs)
- **Container** — alpine-minimal, single process tree under `tini`, runs `pr-review-shim` which self-supervises `opencode-server` as a child
- **Logging** — Cloud Logging captures stdout/stderr; retention follows the `_Default` log bucket policy at the project level
- **Secrets** — phase 1 carries the few config secrets (`DOUBLEWORD_API_KEY`, `GITHUB_APP_ID`/`INSTALLATION_ID`/`PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `OPENCODE_SERVER_PASSWORD`) as Cloud Run env vars rather than Secret Manager references. This was a controlled trade-off because the project's IAM policy required project-IAM-admin to grant the service account access to Secret Manager; for a short-lived experiment with rotatable keys this was acceptable. **Production deployments must move to Secret Manager.**
- **No persistent state** — sessions and PR review state live in-memory on the single instance; opencode SQLite migrations run on startup against ephemeral container storage

The full source for this deployment is in the `experiment/phase-1-sync-provider` branch of the [doublewordai/opencode fork](https://github.com/doublewordai/opencode/tree/experiment/phase-1-sync-provider).

---

## Phase plan

Phases progressively change *only* the inference path. The harness (shim + opencode + GitHub App + Cloud Run service) stays the same.

| Phase | Inference path | Hypothesis under test | Linear |
|---|---|---|---|
| 1 (this) | Sync chat-completions, realtime tier | Baseline | [COR-364](https://linear.app/doubleword/issue/COR-364) ✅ Done |
| 2 | `createDoublewordAsync` (autobatcher, flex tier, client-side batching) — from [vercel-doubleword](https://github.com/doublewordai/vercel-doubleword) | Client-side batching may be overwhelmed by parallel tool calls in opencode's loop | [COR-365](https://linear.app/doubleword/issue/COR-365) |
| 3 | Open Responses API + `service_tier=flex` (long-held connection, no background) | Long-held HTTP connections may time out at intermediate proxies / load balancers | [COR-366](https://linear.app/doubleword/issue/COR-366) |
| 4 | Open Responses API + `service_tier=flex` + `background=true` (poll) | Polling resolves both phase-2 and phase-3 failure modes; agent loop must restructure for non-blocking inference | [COR-367](https://linear.app/doubleword/issue/COR-367) |

For each subsequent phase: branch from `experiment/phase-1-sync-provider`, swap out the provider configuration in `opencode.json`, redeploy, retrigger PR #1047, score the resulting review against ground truth, append the phase's findings to this doc's friction tally + create a benchmark comparison row.

The final phase produces the 4-way comparison doc and the recommendation on whether the parent project ([Multi-Tier Agentic Tools](https://linear.app/doubleword/project/multi-tier-agentic-tools-70de986f3f32)) is validated.
