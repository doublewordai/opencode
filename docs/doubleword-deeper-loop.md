# Deeper-loop review variant

A parallel variant off [`experiment/phase-1-sync-provider`](https://github.com/doublewordai/opencode/tree/experiment/phase-1-sync-provider) that swaps the prompt and the steps cap to drive longer, more research-heavy review sessions.

This is **not** part of the COR-362 four-phase sequence. It's an orthogonal axis: same inference path as phase 1 (sync chat-completions, realtime tier), but with the agent encouraged to consume more tool calls per review.

## What's different from phase 1

- **Steps cap raised from 20 to 100.** The 20-step phase-1 cap was a runaway-loop guardrail; we want to see what the agent does with substantially more headroom before hitting it.
- **Prompt restructured.** The new prompt explicitly:
  - Asks the agent to research before opining (`webfetch` framework docs, OWASP, CVE databases, anti-pattern catalogues)
  - Asks it to cross-reference patterns inside the repo via `grep` (a finding grounded in "the rest of this codebase does X" is stronger than one floating in isolation)
  - Lists the areas to scrutinise explicitly so the agent walks through each one rather than skimming
  - Adds a `## Research notes` section to the output format so URLs the agent fetched are visible to reviewers (and to us scoring the run)
  - States "the longer your session, the better" — explicitly counter to the AI tendency to be terse
- **Prompt also adds an output rubric** with concrete `Why it matters` and `Suggested fix` per finding, so reviews are richer to read.

## Model

The same `Qwen/Qwen3.5-397B-A17B-FP8` model is wired in `opencode.json`. To swap to a more powerful model at deploy time without rebuilding the image, set `REVIEW_MODEL_ID` (and optionally `REVIEW_MODEL_PROVIDER`) on Cloud Run:

```bash
gcloud run services update pr-review-harness --region=europe-west4 \
  --update-env-vars=REVIEW_MODEL_ID=<new-model-id>
```

The model must also be declared in `opencode.json`'s `provider.doubleword.models` map (with `tool_call: true` and a `limit` block) before the agent can use it. If you want to test with a model that isn't yet in the map, edit `opencode.json` first and rebuild.

## What we're trying to learn

Phase 1 scored 13/24 direct hits + 3 partials in 72 s on PR #1047. Some misses were "subtle correctness issues that need deeper data-flow analysis" — exactly the kind of thing more tool loops + more research could catch.

Open questions this variant should answer:

- Does the agent actually use `webfetch` and `grep` more under the new prompt, or does it ignore the encouragement and finish in the same number of turns?
- Does the score against PR #1047's ground truth go up — particularly on the 11 misses from phase 1 (per-render env reads, stale closures, optimistic UI rollback, etc.)?
- What's the latency-vs-quality curve? If a longer session catches 3 more issues but takes 5× as long, is that the right trade for a review bot?
- How often does the agent hit the 100-step cap? If it routinely runs to 100 steps, the cap is too tight; if it never approaches 100, the prompt isn't actually driving more loops.

## Deployment

Same harness as phase 1. Build + push + deploy with the same runbook (`docs/doubleword.md`, "Deployment runbook" section). Re-trigger PR #1047 the same way. Score against the same ground-truth file. Add a row to the comparison doc when the parent COR-362 4-way is finalised so this variant is comparable across the same PR.
