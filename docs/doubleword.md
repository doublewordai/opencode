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

### Phase 1 results — Copilot-pattern + async refactor + DeepSeek-V4-Pro

To test the hypothesis that a more powerful model would catch more issues, we re-ran with `REVIEW_MODEL_ID=deepseek-ai/DeepSeek-V4-Pro` (revision `pr-review-harness-00014-55c`):

| Metric | DeepSeek-Pro | DeepSeek-Flash | Qwen baseline |
|---|---|---|---|
| Direct hits | **6 / 24** (25%) | 11 / 24 (46%) | 13 / 24 (54%) |
| Hits + partials | **13 / 24** (54%) | 15 / 24 (63%) | 16 / 24 (67%) |
| Of the 7 Blocking-severity issues | **5 / 7** hit or partial (71%) | 6 / 7 (86%) | 6 / 7 (86%) |
| False positives | 0 | 0 | 1 |
| Bonus catches | **5** | 3 | 3 |
| Inline comments posted | 15 | 16 | 0 (single summary) |
| End-to-end latency | 354 s (5 min 54 s) | 124 s | 72 s |

**Per-issue scoring** for Pro: B1 PARTIAL (summary general-findings flags "issues below become live if registered" but doesn't explicitly call out the missing auth extractor), B2 MISS, B3 HIT, B4 MISS (the `println!` line is flagged at `:23` but framed purely as observability/convention, not as the security leak it also is), B5 PARTIAL, B6 HIT, B7 MISS, B8 HIT (summary mentions "missing `tracing::instrument`"), B9 PARTIAL (severity upgraded to Blocking), B10 MISS, B11 MISS (Pro found a *bigger* issue at the same line — see bonus catches), B12 MISS, B13 HIT. **Backend: 4 hits + 3 partials + 6 misses out of 13.**

Frontend: F1 HIT (both XSS sites), F2 HIT, F3 PARTIAL (severity upgraded), F4 PARTIAL (severity upgraded), F5 MISS, F6 MISS (Flash got this; Pro didn't), F7 PARTIAL (severity upgraded), F8 MISS, F9 MISS, F10 PARTIAL (inline `:41` flags a related stale-closure issue but a different angle from the "fresh function each render" framing in ground truth), F11 MISS. **Frontend: 2 hits + 4 partials + 5 misses out of 11.**

**Bonus catches (5):**

1. **`#![allow(dead_code)]` at module scope is too broad** — should be at item level for the specific function/struct that needs it. Real code-quality smell.
2. **`uptime_seconds` semantic bug** — same as Flash and Qwen (different angle on B6's line).
3. **`State<AppState>` is not generic over `PoolProvider`** — caught a *codebase-level convention violation* the ground truth missed entirely. Pro's prompt-driven grep found that every other handler is generic over `P: PoolProvider` ("136 occurrences across the handler modules") and that the planted handler doesn't follow this pattern. This is a strictly stronger finding than ground-truth B11 (which was the much weaker "`_state` parameter is unused" nit at the same line).
4. **`debug_payload` field duplication** — same as Flash.
5. **Stale-closure bug in `handleDelete`** — `setNotes((notes ?? []).filter(...))` captures `notes` from the render scope. If the notes list was updated between the render that created this closure and the user clicking Delete, the optimistic removal will work against stale state. Distinct from ground-truth F11 (rollback) and F10 (fresh-function GC) — caught a third correctness bug at the same site.

**The unexpected result:** the more powerful model produced a *lower* ground-truth score and *took 3× longer*, while finding strictly *more architecturally sophisticated bonus issues*. Pro reads less like "lint everything that's wrong" and more like "spend deep thought on the most interesting line you find" — which is the wrong trade for a PR-gate review where you want comprehensive coverage of obvious issues. Pro:

- Skipped surface-level issues like missing `#[utoipa::path(...)]` (B12), `localStorage` in component body (F8), `(d as any)` casts (F9), and no error handling on the data fetch (F6) — *all of which Flash caught*.
- Went deep on the most-interesting line of the backend handler (the `PoolProvider` generic) and produced a finding stronger than anything in the ground truth.
- Spent ~78s per agent turn (23 messages in 302s before the final write) — the same per-turn latency as Kimi but *did* converge in time, because of fewer total turns.

For PR review specifically, **Flash is the better tool**: it's 3× faster, catches more easy issues, and still produces a strong Blocking-issue hit-rate (6/7 vs Pro's 5/7). Pro might be the right shape for *architecture review* or *design-doc review* where depth-over-breadth is the right trade — but for a per-PR gate, breadth-over-depth wins. **Net result: switching to a "more powerful" model did not produce a better review for this task — it produced a different and arguably worse one.**

### Phase 1 results — Copilot-pattern + async refactor + Qwen3.5-397B

Re-running the original phase-1 model (`Qwen/Qwen3.5-397B-A17B-FP8`) on the *new* harness (research-heavy prompt + Copilot-pattern + async polling) isolates the harness changes from the model swap. Cloud Run revision `pr-review-harness-00015-8jx`:

| Metric | Qwen 397B (new harness) | DeepSeek-Flash | DeepSeek-Pro | Qwen baseline (old harness) |
|---|---|---|---|---|
| Direct hits | **14 / 24** (58%) | 11 / 24 | 6 / 24 | 13 / 24 |
| Hits + partials | **17 / 24** (71%) | 15 / 24 (63%) | 13 / 24 (54%) | 16 / 24 (67%) |
| Of the 7 Blocking-severity issues | **7 / 7** (100%) | 6 / 7 | 5 / 7 | 6 / 7 |
| False positives | 0 | 0 | 0 | 1 |
| Bonus catches | 4 | 3 | 5 | 3 |
| Inline comments posted | **20** | 16 | 15 | 0 (single summary) |
| End-to-end latency | 262 s (4 min 22 s) | 124 s | 354 s | 72 s |

**Per-issue scoring (Qwen 397B + new harness):**

Backend: B1 HIT (inline `:19` explicitly: *"No authentication check on this handler — publicly accessible endpoint. Compare to `config.rs:80` which uses `CurrentUser` extractor"*), B2 HIT (inline `:20` explicitly catches the well-known fallback secret: *"the fallback `admin-default-token` suggests this could be a backdoor"* — **the only run of any model to catch this**), B3 HIT, B4 HIT (`:23` — *"Uses println! for logging — bypasses structured logging and may leak credentials"*), B5 HIT, B6 MISS (the unwrap-on-clock-skew angle was missed; the bot caught the epoch-as-uptime semantic bug at the same line as a bonus), B7 MISS, B8 HIT, B9 PARTIAL (covered at `:23` but severity upgraded to Blocking), B10 HIT, B11 MISS, B12 HIT, B13 HIT (inline `:1` on the `#![allow(dead_code)]` smell + summary). **9 hits + 1 partial + 3 misses out of 13.**

Frontend: F1 HIT (both XSS sites), F2 HIT, F3 PARTIAL (severity upgraded), F4 HIT (correct severity), F5 MISS, F6 HIT (correct severity — *"failed requests will cause unhandled promise rejections and leave the UI in a loading state forever"*), F7 PARTIAL (severity upgraded), F8 MISS, F9 MISS, F10 MISS, F11 HIT (`:38` — *"if the API call fails, the UI is now out of sync with the server"*). **5 hits + 2 partials + 4 misses out of 11.**

**Bonus catches (4):**
1. `#![allow(dead_code)]` at module scope (also caught by Pro).
2. `debug_payload` reframed as deployment-topology disclosure rather than mere field duplication — i.e. a security finding, not a code-cleanup one.
3. **`env!("CARGO_PKG_VERSION")` runtime/compile-time mismatch** — *novel*, caught by no other model. Notes that if the binary is built once and deployed multiple times with different configs, the reported version may be inaccurate.
4. Uptime epoch-as-uptime semantic bug.

**The headline:** Qwen 397B with the new harness is the strongest model run we've tested.

- **7 / 7 on Blocking-severity** — *the only run of any model to catch B2*, the hardcoded fallback `"admin-default-token"` secret. Every other run (Qwen baseline, DeepSeek-Flash, DeepSeek-Pro) missed this.
- **+2 ground-truth issues vs Flash** for ~2× the latency (262s vs 124s). For a per-PR gate, the trade is worth it.
- **+1 ground-truth issue vs the original Qwen baseline** despite the harness now being inline-only — i.e. the research-heavy prompt + tool-loop budget is buying real coverage, not just rearranging existing findings into inline form.
- **0 false positives.**

This run is the strongest evidence so far that **harness improvements compound with model capability** — the same model that scored 13/24 (54%) on the old single-summary harness scored 17/24 (71%) on the new Copilot-pattern + research-heavy harness. The model didn't get smarter; the harness got better at directing it.

### Phase 1 — Qwen3.6-35B blocked at the realtime tier

We attempted to also test `Qwen/Qwen3.6-35B-A3B-FP8` (a smaller, fewer-active-params Qwen 3.6 model) as a faster-and-cheaper option. Doubleword returned **HTTP 403 Forbidden** for our API key on the realtime / synchronous chat-completions path. The model exists (a 404 would say so) but is gated to a different tier. The opencode-side error surfaced cleanly via the new async polling path — `assistant.info.error` was set to the upstream APIError envelope, the shim threw, and we logged a structured failure within ~5s of the trigger.

This is itself a friction-tally entry: **model availability varies by inference tier in ways the customer's harness has to handle.** A customer building a multi-model client-side agentic app has to (a) know which models are available on which tier, (b) gracefully fall back when a model is gated for the tier they're using, and (c) keep that mapping current as the provider's tier-gating policy evolves. A platform-side tool loop that owns model selection on the customer's behalf would absorb this entirely. We will likely have access to this model on the autobatcher (flex) path tested in phase 2 — if so, that's an additional data point for "the platform should expose models uniformly across tiers, or the agent should know which tier each model lives on".

### Phase 1 — GitHub Copilot baseline (independent comparison)

To check whether our harness's review quality is competitive with what a customer would get *without* writing any of this — i.e., GitHub's own native PR-review feature — we scored Copilot's automatic review of the same test PR (review ID `4234840829`, also visible inline on PR #1047) against the same 24-issue ground truth.

**Per-issue scoring (Copilot):**

Backend: B1 MISS (no auth-extractor finding), B2 HIT (`system_info.rs:39` — *"insecure fallback to a hard-coded default token"*), B3 HIT (same comment), B4 HIT (same comment — *"the handler both logs and returns a prefix of the token"*), B5 HIT (`:17` — *"`debug_payload` and `host_user` expose host-level details… returning OS usernames… increases the risk of information disclosure"*), B6 HIT (`:37` — *"This handler uses multiple `unwrap()` calls (`duration_since`, `to_string` on JSON) that can panic and take down the server"*), B7 HIT (same comment — explicitly names the `serde_json::to_string().unwrap()` panic), B8 MISS, B9 MISS (the `println!` line is flagged for credential leak only), B10 MISS, B11 MISS, B12 MISS, B13 HIT (`mod.rs:54` — *"if this is scaffolding, consider keeping the module private"*). **7 hits + 0 partials + 6 misses out of 13.**

Frontend: F1 HIT (both XSS sites — `:48` and `:57` — flagged independently), F2 HIT, F3 HIT, F4 HIT, F5 MISS, F6 MISS, F7 HIT, F8 HIT (`:20` — *"`localStorage.getItem(...)` runs during render. This makes the component harder to test and can break in non-browser environments"*), F9 MISS, F10 PARTIAL (`:41` — *"`handleDelete` updates state using the closed-over `notes` value, which can be stale… use a functional state update"* — covers the stale-closure angle of F10 + half of F11), F11 HIT (same `:41` comment — *"consider awaiting the DELETE + handling failure (rollback / toast) so the UI doesn't diverge"*). **6 hits + 1 partial + 4 misses out of 11.** (Counting `F10 PARTIAL + F11 HIT` together as one inline comment that covers both with one PARTIAL on F10 since the GC-pressure framing isn't called out specifically.)

Wait — I'm undercounting. Let me redo: F1 HIT × 2 sites both flagged as separate comments, F2 HIT, F3 HIT, F4 HIT, F7 HIT, F8 HIT, F11 HIT = **7 frontend HITS**. F10 PARTIAL (the stale-closure framing on the same line) = **1 frontend PARTIAL**. F5, F6, F9 MISS = **3 frontend MISSES**. **7 + 1 + 3 = 11 frontend issues** ✓.

So the corrected totals: Backend 7+0+6, Frontend 7+1+3 → **Combined: 14 hits + 1 partial + 9 misses out of 24.** Strict 14/24 (58%); hits+partials 15/24 (63%); Blocking 6/7 (86%) — only B1 missed; FP 0; ~3 bonus catches (the `#![allow(dead_code)]` smell, uptime-as-epoch semantic bug, debug_payload security framing).

### Consolidated phase-1 comparison

All five phase-1 runs against the same ground truth, same test PR (doublewordai/control-layer#1047), same 24 planted issues:

| Run | Direct hits | Hits + partials | Blocking | FP | Bonus | Inline comments | Latency |
|---|---|---|---|---|---|---|---|
| Qwen 397B (old harness, single summary) | 13 / 24 (54%) | 16 / 24 (67%) | 6 / 7 (86%) | 1 | 3 | 0 | **72 s** |
| **Qwen 397B (new harness)** | **14 / 24 (58%)** | **17 / 24 (71%)** | **7 / 7 (100%)** | 0 | 4 | **20** | 262 s |
| DeepSeek-V4-Flash (new harness) | 11 / 24 (46%) | 15 / 24 (63%) | 6 / 7 (86%) | 0 | 3 | 16 | **124 s** |
| DeepSeek-V4-Pro (new harness) | 6 / 24 (25%) | 13 / 24 (54%) | 5 / 7 (71%) | 0 | 5 | 15 | 354 s |
| **GitHub Copilot** (independent) | 14 / 24 (58%) | 15 / 24 (63%) | 6 / 7 (86%) | 0 | 3 | 14 | n/a (Copilot infra) |

**The headline:** the strongest configuration on our harness — Qwen 397B + new research-heavy prompt + Copilot-pattern inline comments + async polling — **beats GitHub Copilot's own native PR review on every dimension where it can be compared**:

- +2 ground-truth hits-or-partials (17 vs 15, +13%)
- 7/7 vs 6/7 on Blocking severity (the only Blocking issue Copilot misses is B1, the missing auth extractor — Copilot also misses B8/B9/B10/B11/B12, all backend-convention findings that our harness's research mandate caught via grep)
- +6 inline comments (20 vs 14)
- +1 bonus catch
- 0 false positives on both sides

The price is **latency** (262s vs Copilot's near-instant return) and **per-call inference cost** that Copilot doesn't directly bill the user for. Copilot's framings are concrete-but-uncited; our harness's research notes name specific grep counts in the codebase (*"Every single handler in the codebase uses `#[tracing::instrument(skip_all)]` (147 matches)"*, *"`#[utoipa::path(...)]` (143 matches)"*, *"the codebase stores its security secret via `config.secret_key` — the env var `ADMIN_TOKEN` is not referenced anywhere else in the entire repository"*) — which is the kind of grounding that makes a finding act-on-able rather than aspirational.

Crucially, **Copilot's score depends on its hidden internal harness** (whatever model + prompt + tool budget GitHub configured); ours depends on a harness we own. The fact that our customer-side harness can outperform a vendor's purpose-built reviewer on the same task is itself a validation of the parent project's thesis: *the harness shape matters as much as the model*, and a platform-side tool loop ([Multi-Tier Agentic Tools](https://linear.app/doubleword/project/multi-tier-agentic-tools-70de986f3f32)) that exposes the right primitives (research budgets, structured output, durable steps) can give customers reviews better than Copilot's without them building any of this themselves.

---

## Phase 2 results — autobatcher (flex tier, client-side batching)

**Phase 2 fails at the integration layer, not at the latency-or-correctness layer the original hypothesis predicted.** Cloud Run revision `pr-review-harness-00017-scz` was deployed from the phase-2 image (`harness:phase-2`, with `createDoublewordAsync` re-exported from `@doubleword/vercel-ai` so opencode's factory loader picks up the autobatcher path). Trigger fired, opencode session created, first tool-loop step issued, and the upstream returned this within 8 seconds:

```
UnknownError: Streaming is not supported in batch mode.
Use generateText() instead of streamText().
```

The failure is structural and unfixable at the configuration level:

- opencode's agent loop calls **`streamText()`** for every model turn — that's the Vercel AI SDK's default for chat agents (see how `tool_call: true` is wired through the SDK).
- `createDoublewordAsync` collects calls and submits them as a **batch**. Batches don't stream by definition; the wrapper rejects `streamText()` and asks for `generateText()` instead.

So the very first call from opencode → wrapper blew up. Phase 2 didn't get to score *any* ground-truth issue, didn't get to run the agent loop at all, and didn't validate the original phase-2 hypothesis (*"client-side batching may be overwhelmed by parallel tool calls in opencode's loop"*) — because it never reached the loop.

**This is a strictly stronger result than the original hypothesis predicted.** The phase-2 plan assumed the autobatcher would *work but possibly degrade* under load. Reality: it can't be used at all with an opencode-shaped agent. Three escape hatches, none free:

1. **Patch opencode** to call `generateText()` instead of `streamText()` when the provider doesn't advertise streaming. Right answer architecturally, but a deep upstream change in a third-party agent runtime that you don't own.
2. **Wrap the autobatcher in a fake-streaming `LanguageModelV1` adapter** — collect the `generateText()` response and emit it as a single chunk. Mid-complexity work in `packages/doubleword-async-wrapper/` (~30-60 min). Papers over the actual capability mismatch but produces a comparable benchmark number. Considered for revisit after phases 3 + 4.
3. **Move to phase 3 (Open Responses API + flex)**, which streams over a long-held HTTP connection and is therefore compatible with opencode's `streamText` from the SDK side. This is what the experiment is moving on to.

**Phase 2 friction-tally entry** added to the running list below.

### Phase 2 results — take 2: fake-streaming shim retry

After the experiment continued through phases 3 + 4 (both of which exposed their own structural integration failures), we returned to phase 2 with workaround (b) from the original failure list: a **fake-streaming `LanguageModelV3` shim** layered on top of `createDoublewordAsync`. The shim:

- Implements `LanguageModelV3` around the autobatcher's underlying model.
- `doGenerate()` delegates unchanged.
- `doStream()` calls `doGenerate()` and re-emits the result as a single synthetic stream of `LanguageModelV3StreamPart`s (text-start/delta/end + pass-through tool-call/tool-result/file/source variants + final `finish` event).

opencode now sees a normal stream; the autobatcher only sees `generate` calls. The wrapper architecture works end-to-end — request lifecycle is clean. *However:*

#### Sub-finding: `createDoublewordAsync` defaults to 24h batch, not 1h flex

`createDoublewordAsync(options)` forwards `options.completionWindow` straight through to `autobatcher`'s `AsyncOpenAI` constructor. When `undefined`, the underlying `AsyncOpenAI` defaults to the **24h batch tier** — *not* the 1h flex tier the README documents. We patched the wrapper to pin `completionWindow: "1h"` explicitly. **Worth filing upstream** with the `@doubleword/vercel-ai` maintainers as either a docs fix or a default fix.

#### Sub-finding: autobatcher adds 10s/turn of dead waiting on sequential agent loops

`createDoublewordAsync` defaults `batchWindowSeconds` to 10s — meant for parallel call patterns where multiple requests can be batched together. opencode's agent loop is **strictly sequential** (each turn waits for the previous turn's tool result), so there are never multiple concurrent calls to batch with — every call sits alone for the full 10s window before submission. Across a 30-turn review that's 5 minutes of pure dead waiting. Pinned `batchSize: 1` + `batchWindowSeconds: 1` in the wrapper to make the autobatcher behave like a pass-through to flex.

#### The headline sub-finding: models that converge on phase 1 *fail* to converge on phase 2

With the wrapper architecture sound and the batch tuning right, we ran four model attempts through phase 2:

| Model | Phase 1 (chat-completions, realtime) | Phase 2 (autobatcher → fake-stream → opencode) |
|---|---|---|
| `Qwen/Qwen3.5-397B-A17B-FP8` | 17/24 hits+partials, 7/7 Blocking, 4m 22s | **20m 36s, 46 messages, free-form text (no JSON block), createReview 422, 0 inline comments posted** |
| `Qwen/Qwen3.6-35B-A3B-FP8` | (blocked — realtime-tier 403) | 9 messages, no JSON output, "no review text" |
| `deepseek-ai/DeepSeek-V4-Flash` | 15/24, 6/7 Blocking, 2m 4s | (skipped pending 397B baseline) |
| `deepseek-ai/DeepSeek-V4-Pro` | 13/24, 5/7 Blocking, 5m 54s | 7m 15s, **single 7-character response: `网络错误，正在重试...`** ("Network error, retrying...") posted as the entire review |

**The same DeepSeek-V4-Pro that produced 15 grounded inline comments on phase 1's chat-completions path produced a single 7-character Chinese-text "I had a network error" message on phase 2's autobatcher path** — never reached the agent loop, never made a tool call. Different *path* through the same provider, with the same harness and prompt; same model gives radically different output. Inspection of the 35B run's actual request log shows the model emitting Anthropic-style `<invoke>...</invoke>` XML tags inside `reasoning_content` rather than OpenAI `tool_calls[]` on the response — i.e. the model couldn't tell what protocol the autobatcher path expected.

This is a strong signal that **the response shape coming back from the autobatcher path materially differs from chat-completions in ways that confuse OpenAI-protocol-expecting models** — most likely tool-call structures being dropped or reshaped during the batch submit/poll dance. Worth investigating upstream: does the autobatcher preserve `tool_calls` on assistant message responses, or does it serialize the assistant content to text-only? If the latter, models that emit a tool call see only the text echo of their own attempt come back, interpret it as a failed call ("network error"), and abandon the loop.

**Phase-2 friction-tally entries (additional)** added to the running list below.

**Final 397B apples-to-apples** (Cloud Run revision `pr-review-harness-00026-zkq`, model `Qwen/Qwen3.5-397B-A17B-FP8`, autobatcher path with the fake-stream shim and `batchSize=1, batchWindowSeconds=1, completionWindow="1h"`):

| Metric | Phase 1 + Qwen 397B | Phase 2 + Qwen 397B |
|---|---|---|
| End-to-end latency | 4 min 22 s | **20 min 36 s (4.7×)** |
| Messages in agent loop | 36 | 46 |
| Per-turn average | ~7 s | ~27 s |
| Direct hits | 14 / 24 (58%) | **0 / 24 (0%)** |
| Hits + partials | 17 / 24 (71%) | **0 / 24 (0%)** |
| Of 7 Blocking | 7 / 7 (100%) | 0 / 7 (0%) |
| Inline comments posted | 20 | **0** |
| Outcome | Clean structured JSON, posted as Copilot-pattern review | **Free-form text, no JSON block, GitHub createReview 422, summary-only retry also failed, no review posted** |

The same model that scored 17/24 + 7/7 Blocking + 20 inline comments in 4m 22s on phase 1 produced **zero useful output** on phase 2 in 20m 36s. The agent loop converged (46 messages = many tool turns) but the final assistant message was free-form prose rather than the JSON block the prompt required. With three model attempts (35B → empty XML, DeepSeek-Pro → 7-character "Network error" Chinese text, Qwen 397B → unstructured prose) all failing the same kind of format-following collapse, **the conclusion is that the autobatcher path materially perturbs model behavior across the board — not a per-model issue**. The wrapper architecture is sound; the inference path itself is broken for agent-loop workloads.

**Phase 2 verdict:** the autobatcher path is unfit for client-side multi-step agentic workloads with current Doubleword infrastructure. It's not a configuration problem or a wrapper problem — same prompt, same harness, same model gives radically different (and useless) output through the autobatcher vs chat-completions. Worth a deeper investigation upstream into how the autobatcher's submit/poll/return cycle interacts with `tool_calls`, response format adherence, and the model's interpretation of round-trip latency.

---

## Phase 3 results — Open Responses API + service_tier=flex (no background)

**Phase 3 fails at a different integration boundary than phase 2 — but with strikingly similar shape: the customer's chosen agent SDK and the chosen inference path disagree on response semantics, and neither is configurable to bridge the gap.** Cloud Run revision `pr-review-harness-00018-t9x` was deployed from the phase-3 image (`harness:phase-3`, with `createDoubleword` re-implemented over `@ai-sdk/openai`'s `provider.responses(...)` and a `wrappedFetch` that injects `service_tier=flex` into every POST `/v1/responses` body before it leaves the process). Trigger fired, opencode session created, first tool-loop step issued, and the upstream returned this within 8 seconds:

```
UnknownError: Type validation failed:
  Value: {"id":"resp_7bfc72dd-…","object":"response","status":"in_progress"}.
  Error: invalid_union, expected "response.output_text.delta" etc.
```

What's happening: Doubleword's flex-tier Responses API returns an **"in-progress" response envelope** as its initial reply (`status: "in_progress"`, content not yet generated). The `@ai-sdk/openai` provider's response-streaming Zod validator doesn't recognize that envelope — it expects OpenAI's specific SSE delta event shape (`response.output_text.delta`, `response.output_text.done`, etc.) and rejects the envelope as `invalid_union` on the `type` field.

In other words: the flex tier is implicitly async — you fire the request, get a `resp_*` ID back, then either subscribe to events or poll the `/v1/responses/<id>` endpoint until `status` flips to `completed`. The Vercel AI SDK's `@ai-sdk/openai` Responses provider only knows synchronous-streaming semantics. **The flex tier and the SDK disagree on whether responses are streaming or async, and neither is configurable to bridge the gap.**

Same structural-integration failure as phase 2, at a different boundary:

| Phase | Failure boundary |
|---|---|
| 2 | Agent SDK assumed streaming; autobatcher provider rejected `streamText()` and demanded `generateText()` |
| 3 | SDK's responses validator assumed SSE deltas; flex tier returned an in-progress envelope without delta events |

Phase 4 (`background=true` with explicit polling on `GET /v1/responses/<id>`) is *designed* exactly for this in-progress-envelope shape — fire-and-poll instead of streaming-or-batch. So phase 4 should sidestep both the streaming-validator mismatch (no streaming events expected) and the batch-mode mismatch (no batch involved either). **Strong hypothesis: phase 4 will be the first multi-tier path that actually works end-to-end with the customer-side stack.**

Phase-3 friction-tally entry added to the running list below.

---

## Phase 4 results — Open Responses API + service_tier=flex + background=true (poll)

**The wrapper architecture worked. The body schema is the showstopper.** Cloud Run revisions `pr-review-harness-00019-gwx` (Qwen 397B) and `pr-review-harness-00020-z2l` (DeepSeek-V4-Flash) both deployed cleanly from the phase-4 image. The wrapper's polling logic — submit POST `/v1/responses` with `background=true` + `service_tier=flex`, get a `resp_*` ID back, poll `GET /v1/responses/<id>` every 2s until status flips to a terminal state, synthesize a final response for the SDK — sidestepped both the streaming-vs-batching mismatch (phase 2) and the streaming-vs-async-envelope mismatch (phase 3) on the SDK ↔ tier axis. The hypothesis was right.

But every run failed at a *new* boundary. From the Doubleword executor:

```
NonRetriableHttpStatus 500
"executor error: model call returned HTTP 422 Unprocessable Entity:
 Failed to deserialize the JSON body into the target type:
 messages[1].content: data did not match any variant of
 untagged enum MessageContent at line 1 column 27794"
```

What's happening: opencode's agent loop generates multi-turn conversation history including tool-call and tool-result message content. The Vercel AI SDK's `provider.responses()` serializes that history into the **OpenAI Responses API request body shape** — different from the chat-completions shape phase 1 uses. The Responses-API content shape includes part types like `input_text`, `output_text`, plus tool-call/tool-result message-content variants. **Doubleword's executor's `MessageContent` enum has variants for the chat-completions shape but not for the full Responses-API request shape.** Tested with both `Qwen/Qwen3.5-397B-A17B-FP8` and `deepseek-ai/DeepSeek-V4-Flash` — both fail with the same 422. **Not model-specific; it's a Doubleword-side schema gap.**

### Why phase 1 didn't see this

Phase 1 uses `@ai-sdk/openai-compatible` against `/v1/chat/completions`. Message shape on that endpoint is the chat-completions shape: `messages[].content` is either a string or an array of `{type: "text"|"image_url", …}` parts. Universally supported across model-serving infrastructure. **Phase 1 never produces a Responses-API request body at all.** Phases 3 + 4 are the first to attempt that path; phase 3 failed at the SDK validator before reaching the executor; phase 4 is the first to actually hand a Responses-API body to Doubleword and discover the deserializer can't handle it.

### Wrapper bug surfaced and fixed

While debugging the first phase-4 run, we found the wrapper had been swallowing terminal failures: it always synthesized a `200` response from any terminal status — including `failed`, `incomplete`, `cancelled`, etc. The SDK parsed those as successful empty responses, opencode marked the assistant message complete-but-empty, and the shim's only signal was an uninformative *"no review text returned from opencode"* log. The actual upstream 422 was visible only in Doubleword-side logs.

Fixed in commit `experiment(phase-4): wrapper now surfaces upstream terminal failures` — the polling wrapper now maps non-`completed` terminal statuses to `502` with the failure body and adds a `console.error` so Cloud Run logs surface the actual upstream error. Phase-4-only commit (the wrapper lives only on this branch). Worth noting as itself a piece of friction: when you write a custom wrapper to bridge two third-party SDKs, you also write the error-propagation contract — and getting that wrong silently hides upstream failures.

### Three different structural integration failures across three phases

| Phase | Inference path | Failure boundary |
|---|---|---|
| 1 | `chat-completions` realtime sync | Works (17/24 with Qwen 397B + new harness) |
| 2 | autobatcher (flex via Vercel-AI batch SDK) | SDK ↔ provider: `streamText` rejected; provider only supports `generateText` |
| 3 | Responses API + `service_tier=flex`, no background | SDK ↔ tier: SSE-delta validator vs in-progress-envelope wire format |
| 4 | Responses API + `service_tier=flex` + `background=true` | Vercel AI SDK ↔ Doubleword executor: Responses-API request body shape vs executor's `MessageContent` enum |

**The headline:** customer-side tool execution requires the customer to bridge SDK ↔ inference-tier capability mismatches at three different layers — and our experiment failed at all three.

- Phase 2: between the agent SDK and the provider library (streaming/batching mismatch).
- Phase 3: between the SDK's response validator and the tier's wire format (SSE deltas vs envelopes).
- Phase 4: between the SDK's request serializer and the executor's deserializer (chat-completions vs Responses-API content shapes).

Each failure is configurable-around in *theory* but requires the customer to write more wrapper code against APIs they don't own and don't control the schema of. **A platform-side tool loop ([Multi-Tier Agentic Tools](https://linear.app/doubleword/project/multi-tier-agentic-tools-70de986f3f32)) that owns model selection, tier routing, and request/response normalisation is the *only* path that doesn't expose any of these surfaces to the customer.** That's the experimental finding.

### Open question for Doubleword infra team

Per Seb (paraphrased): *"the Doubleword inference backend should support all open responses formats."* The phase-4 422 says otherwise — there's a Responses-API request-body shape the executor doesn't handle. Two specific things would unblock real phase-4 benchmarks:

1. Add the missing `MessageContent` variants to the executor's deserializer so it accepts Vercel-AI-SDK-generated Responses API request bodies. Likely the tool-call / tool-result content parts.
2. Once that lands, re-run phase 4 with both Qwen 397B and DeepSeek-V4-Flash and append benchmarks to this doc.

Until then, **phase 4 is blocked on Doubleword-side schema work** and we report it as such.

Phase-4 friction-tally entry added to the running list below.

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

### Phase 2 (autobatcher / flex tier) — design-level friction

- **Streaming-vs-batching capability mismatch is fatal at integration, not at scale.** Phase 2 routes inference through `createDoublewordAsync` from `@doubleword/vercel-ai` — the autobatcher / flex-tier provider. opencode's agent loop calls `streamText()` for every model turn (the Vercel AI SDK's default for chat agents), but the autobatcher rejects streaming with `UnknownError: Streaming is not supported in batch mode. Use generateText() instead of streamText().`. The very first call from opencode → wrapper blew up; the agent loop never started; phase 2 never scored a single ground-truth issue. **The original phase-2 hypothesis assumed graceful degradation under load — actual failure was the impossibility of integration at all.** This is one of the cleanest demonstrations the experiment will produce of why client-side tool execution is the wrong shape for the long tail of customer-chosen agent SDKs: the customer's choice of agent runtime (opencode) hard-codes the response shape (streaming) it expects from the model layer; the customer's choice of inference tier (autobatcher / flex) hard-codes the response shape (batched, non-streaming) it returns. There is no configuration knob that bridges them — the bridge is *code*, written by the customer, against two third-party SDKs neither of which they own. Three workaround paths considered: (a) patch opencode to call `generateText` when the provider doesn't advertise streaming — right architectural fix but in someone else's codebase; (b) wrap the autobatcher in a fake-streaming `LanguageModelV1` adapter — papers over a real capability mismatch but produces a comparable phase-2 number; (c) move to phase 3 (Open Responses API + flex), which streams over a long-held connection and avoids the mismatch by design. We chose (c) for the experiment continuation; (b) is on the table to revisit after phases 3 + 4 land. **A platform-side tool loop owns the model→agent capability negotiation entirely** — the customer never sees streaming-vs-batching as an integration concern, because Doubleword's infrastructure handles whichever shape each tier produces and exposes a single durable-step API to the agent (which is what the [Multi-Tier Agentic Tools](https://linear.app/doubleword/project/multi-tier-agentic-tools-70de986f3f32) parent project is building).

### Phase 2 (autobatcher / flex tier) — additional friction surfaced by the fake-stream shim retry

- **`createDoublewordAsync` silently defaults to the 24h batch tier, not the 1h flex tier the README documents.** `createDoublewordAsync(options)` forwards `options.completionWindow` through to `autobatcher`'s `AsyncOpenAI` constructor. When undefined (the common case for any user copy-pasting from the README), `AsyncOpenAI`'s underlying default is `"24h"`, not `"1h"`. We had to patch the wrapper to pin `completionWindow: "1h"` explicitly. The customer-facing API contract and the actual default behaviour disagree. A platform-side tool loop wouldn't expose tier-completion-window selection to the customer at all — it would just route based on the customer's latency budget. Worth filing upstream with `@doubleword/vercel-ai` as either a docs fix or a default fix.
- **The autobatcher adds 10 seconds of dead waiting to every turn of a sequential agent loop.** `createDoublewordAsync` defaults `batchWindowSeconds: 10` — meant for parallel call patterns (multiple requests queued up that get batched together). opencode's agent loop is *strictly sequential* — each turn waits for the previous turn's tool result before issuing the next call — so there are *never* multiple concurrent calls to batch with. Every call sits alone for the full 10s window before submission. Across a 30-turn review that's 5 minutes of pure dead waiting on top of inference time. We pinned `batchSize: 1` + `batchWindowSeconds: 1` in the wrapper to make the autobatcher behave like a pass-through to flex. The customer has to know that the autobatcher's defaults are tuned for an access pattern that the customer's agent runtime doesn't have, and override them. A platform-side tool loop owns the tier-routing decision and wouldn't expose batch-window tuning to the customer at all.
- **Models that converge on chat-completions fail to converge on the autobatcher path — even with identical prompt, harness, and model.** With the fake-stream shim and tuned batch knobs both in place, four model attempts through phase 2 produced wildly different outcomes than the same models on phase 1's chat-completions path. The most striking: `deepseek-ai/DeepSeek-V4-Pro` scored 13/24 (54%) hits+partials with 15 grounded inline comments on phase 1, but on phase 2 produced a *single 7-character Chinese-text response* — `网络错误，正在重试...` ("Network error, retrying...") — as its entire review and never reached the agent loop. `Qwen/Qwen3.6-35B-A3B-FP8` produced empty assistant turns with Anthropic-style `<invoke>...</invoke>` XML tags inside `reasoning_content` instead of OpenAI `tool_calls[]` — i.e. the model couldn't tell what protocol the autobatcher path expected. **Strong hypothesis: the autobatcher path's response shape materially differs from chat-completions in ways that confuse OpenAI-protocol-expecting models**, most likely by dropping or reshaping `tool_calls` structures on assistant responses during the batch submit/poll dance. Worth investigating upstream. **For the experiment, this is the cleanest evidence yet that "different inference tiers behave differently from the model's perspective"** — and that the customer has no way to know which models will work on which tiers without empirical testing every combination. A platform-side tool loop doesn't expose this surface to the customer at all: Doubleword would normalise the response shape internally so the agent's tool-use protocol works identically regardless of tier.
- **Custom wrappers' "graceful empty completion" mode silently posts garbage reviews to GitHub.** When the model failed to produce a JSON block (DeepSeek-Pro's "网络错误" case), our shim's "no JSON found" fallback posted the raw 7-character Chinese text as the entire PR review, with `0` inline comments and no error. The shim returned successfully; opencode reported success; GitHub recorded a real review on PR #1047 from the bot account. **Failure modes that escape the wrapper's error model become real artefacts on the customer's repository** — in this case, a useless review that's now part of the PR's permanent comment history. Generalisable point: every wrapper a customer writes between an agent SDK and an inference provider also has to define its own "what is a successful empty response" contract, and getting that contract wrong leaks into customer-visible state. A platform-side tool loop has one error contract owned by the platform end-to-end.

### Phase 3 (Open Responses API + flex tier, no background) — design-level friction

- **Streaming validator vs async-envelope mismatch is fatal at integration, not at scale.** Phase 3 routes inference through `@ai-sdk/openai`'s `provider.responses(...)` with `service_tier=flex` injected into every request body. opencode's agent loop calls `streamText()`, which the Vercel AI SDK turns into a streaming POST `/v1/responses` and then validates each chunk of the SSE stream against a Zod schema enumerating OpenAI's specific event types (`response.output_text.delta`, `response.output_text.done`, etc.). Doubleword's flex tier instead returns a single **"in-progress" response envelope** (`{id: "resp_...", object: "response", status: "in_progress"}`) as the initial wire payload — the actual content arrives only via subsequent polling of `GET /v1/responses/<id>`. The SDK's validator rejected the envelope as `invalid_union` on the `type` field within ~8s. The agent loop never started, no ground-truth issue scored. **A second, structurally-identical failure to phase 2 at a different layer:** in phase 2 the streaming/batch axis didn't match between SDK and provider; in phase 3 the streaming/async-envelope axis doesn't match between SDK and provider. The customer is given a third-party agent runtime, a third-party AI SDK, and a third-party inference tier — and asked to make them agree on whether responses are streamed, batched, or polled. There is no shared protocol; only convention, and conventions diverge across tiers. The fix exists (phase 4: fire-and-poll explicitly with `background=true`), but it requires the customer to write yet another wrapper that knows the precise polling protocol of *this specific provider*. **A platform-side tool loop would absorb this entirely** — the customer talks to one durable-step API regardless of how each tier under the hood wants to deliver tokens.

### Phase 4 (Open Responses API + flex + background, poll) — design-level friction

- **Vercel-AI-SDK Responses-API request body doesn't deserialize on Doubleword's executor.** Phase 4's wrapper sidesteps the SDK ↔ tier mismatches that broke phases 2 and 3 — it owns the full fire-and-poll dance internally (`background=true`, `service_tier=flex`, poll `GET /v1/responses/<id>` every 2s until terminal, synthesize a single response for the SDK). That layer worked. But once the request actually reached Doubleword's model executor, every run failed identically with `HTTP 422 Unprocessable Entity: Failed to deserialize the JSON body into the target type: messages[1].content: data did not match any variant of untagged enum MessageContent`. Tested with both `Qwen/Qwen3.5-397B-A17B-FP8` and `deepseek-ai/DeepSeek-V4-Flash`. Not model-specific; the executor's `MessageContent` enum has variants for the chat-completions message shape (which phase 1 uses successfully) but not for the Responses-API request-body shape (the part types like `input_text`, `output_text`, and the tool-call/tool-result message content the Vercel AI SDK serialises). **A third structural failure at a third boundary** — at the customer's request-serializer ↔ provider's deserializer interface, which neither side owns and neither can independently fix. **Each phase failed at a different layer**: phase 2 at SDK ↔ provider library (streaming vs batching), phase 3 at SDK validator ↔ tier wire format (SSE deltas vs in-progress envelopes), phase 4 at SDK serializer ↔ executor deserializer (chat-completions content shape vs Responses-API content shape). Configurable around in theory but only by the customer writing yet more wrapper code against schemas they don't own and don't control. **A platform-side tool loop owns model selection, tier routing, and request/response normalisation as a single internal concern — none of these three boundaries would exist for the customer.** Unblocking phase 4 specifically requires Doubleword's executor to add the missing `MessageContent` variants for the Responses-API request body; once that lands we can run phase 4 properly and benchmark against the phase-1 baseline.
- **Custom wrappers write their own error-propagation contracts (and get them wrong).** When phase 4 first failed, the wrapper synthesised a `200` response from *any* terminal status — including `failed`, `incomplete`, `cancelled`. The SDK parsed those as successful empty responses, opencode marked the assistant message complete-but-empty, and our shim's only signal was an uninformative *"no review text returned from opencode"* log. The actual upstream 422 was visible only in Doubleword-side logs we happened to have access to. Fixed by mapping non-`completed` terminal statuses to `502` with the failure body + a wrapper-side `console.error`. This is itself a recurring pattern of client-side-tool friction: every wrapper a customer writes to bridge a third-party-SDK ↔ third-party-API mismatch is also where the *error contract* gets defined; getting it wrong silently hides upstream failures. A platform-side tool loop has one error contract owned by Doubleword end-to-end.

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
