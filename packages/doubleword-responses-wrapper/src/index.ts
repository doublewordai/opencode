// Phase-3 wrapper: Open Responses API + service_tier=flex (no background).
//
// opencode's bundled-provider registry doesn't recognise this transport, so
// we ship a single-file ESM bundle and reference it via `file://` in
// opencode.json. Same workaround mechanism as phase 2 — see docs/doubleword.md
// "Phase 2 friction" for context.
//
// What it does:
//   - Builds an @ai-sdk/openai provider pointed at Doubleword
//   - Wraps fetch so every POST /v1/responses body gets service_tier=flex
//     injected before the request leaves the process
//   - Returns an SDK shape whose languageModel(modelId) delegates to
//     provider.responses(modelId) — i.e. the Open Responses API path, not
//     the default chat-completions
//
// Why this and not @ai-sdk/openai-compatible: openai-compatible has no
// .responses() method. Only @ai-sdk/openai exposes the Responses API.
//
// What it does NOT do (deferred to phase 4):
//   - background=true and the 202+poll pattern. Phase 3 deliberately holds
//     the HTTP connection open under the flex SLA so we can record proxy /
//     load-balancer timeout failure modes.

import { createOpenAI } from "@ai-sdk/openai";

export interface DoublewordResponsesOptions {
  name?: string;
  apiKey?: string;
  baseURL?: string;
  serviceTier?: string;
}

export function createDoubleword(opts: DoublewordResponsesOptions = {}) {
  const apiKey = opts.apiKey;
  const baseURL = opts.baseURL;
  const serviceTier = opts.serviceTier ?? "flex";

  const wrappedFetch: typeof fetch = async (input, init) => {
    if (
      init?.method === "POST" &&
      init.body &&
      typeof init.body === "string"
    ) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("/responses") && !url.match(/\/responses\/[^/?]+/)) {
        try {
          const body = JSON.parse(init.body);
          body.service_tier = serviceTier;
          init = { ...init, body: JSON.stringify(body) };
        } catch {
          // body wasn't JSON — leave alone
        }
      }
    }
    return fetch(input as RequestInfo, init);
  };

  const provider = createOpenAI({
    baseURL,
    apiKey,
    fetch: wrappedFetch,
  });

  return {
    languageModel: (modelId: string) => provider.responses(modelId),
    chatModel: (modelId: string) => provider.responses(modelId),
    responses: (modelId: string) => provider.responses(modelId),
    textEmbeddingModel: (modelId: string) =>
      provider.textEmbeddingModel(modelId),
    embeddingModel: (modelId: string) => provider.textEmbeddingModel(modelId),
  };
}
