// Flex via chat-completions: the cleanest flex path we've found.
//
// Earlier phase-2 attempts routed inference through `createDoublewordAsync`
// from `@doubleword/vercel-ai` (the autobatcher / AsyncOpenAI batch submit),
// then layered a fake-streaming LanguageModelV3 shim on top so opencode's
// streamText() calls would succeed. That path "worked" but materially
// perturbed model behaviour (see docs/doubleword.md "Phase 2 results" — same
// model + same harness + same prompt scored 10/24 vs phase-1's 17/24, at
// 2.5× latency) because the batch submit/poll round-trip sits between every
// agent turn.
//
// This wrapper abandons the autobatcher entirely. Instead it uses the *exact*
// transport phase 1 validated — `@ai-sdk/openai-compatible` against
// `/v1/chat/completions`, which streams natively and is the universally
// supported message shape — and only adds one thing: it injects
// `service_tier: "flex"` into every chat-completions request body via a
// wrapped fetch. So opencode gets real token streaming and the chat-
// completions content shape (no fake-stream shim, no batch dance, no
// Responses-API serializer/deserializer mismatch), while inference still runs
// on the flex tier.
//
// The only client-side code is the body injection. Everything else — tool
// calls, streaming, message serialisation — is plain `@ai-sdk/openai-compatible`,
// identical to phase 1.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export interface CreateDoublewordOptions {
  name?: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  // Tier to request on every chat-completions call. Defaults to "flex".
  // Override to "default"/"priority" to A/B against the realtime baseline
  // without rebuilding the transport.
  serviceTier?: string;
}

export function createDoubleword(opts: CreateDoublewordOptions = {}) {
  const serviceTier = opts.serviceTier ?? "flex";

  // Inject service_tier into chat-completions request bodies. Streaming is
  // left untouched on purpose — the win over the autobatcher path is that
  // opencode keeps native token streaming through the standard endpoint.
  const wrappedFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    const isChatCompletionsPost =
      init?.method === "POST" && url.includes("/chat/completions");

    if (
      !isChatCompletionsPost ||
      !init?.body ||
      typeof init.body !== "string"
    ) {
      return fetch(input as RequestInfo, init);
    }

    let body: any;
    try {
      body = JSON.parse(init.body);
    } catch {
      return fetch(input as RequestInfo, init);
    }

    body.service_tier = serviceTier;

    return fetch(input as RequestInfo, {
      ...init,
      body: JSON.stringify(body),
    });
  };

  const provider = createOpenAICompatible({
    name: opts.name ?? "doubleword",
    baseURL: opts.baseURL ?? "https://api.doubleword.ai/v1",
    apiKey: opts.apiKey,
    headers: opts.headers,
    fetch: wrappedFetch,
  });

  // opencode's provider loader calls `.languageModel(id)`; `@ai-sdk/openai-
  // compatible` exposes the chat model as `.chatModel(id)` (and is itself
  // callable). Expose both names plus the embedding accessors so the loader
  // finds whichever it asks for.
  const chatModel = (modelId: string) => provider.chatModel(modelId);
  const wrapper: any = (modelId: string) => chatModel(modelId);
  wrapper.languageModel = chatModel;
  wrapper.chatModel = chatModel;
  wrapper.textEmbeddingModel = (modelId: string) =>
    provider.textEmbeddingModel(modelId);
  wrapper.embeddingModel = (modelId: string) =>
    provider.textEmbeddingModel(modelId);
  return wrapper;
}
