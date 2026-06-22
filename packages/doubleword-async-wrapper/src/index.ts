// Flex via chat-completions + fake-streaming shim.
//
// Two facts drive this design:
//
//   1. Doubleword's flex tier IS reachable on the standard
//      /v1/chat/completions endpoint by setting `service_tier: "flex"` in the
//      request body — it returns a normal, synchronous, well-formed
//      chat.completion object (tool_calls included). No batch submit/poll, no
//      async in-progress envelope. This is the clean content shape phase 1
//      validated.
//
//   2. BUT the flex tier silently ignores `stream: true`. A streaming request
//      to flex comes back as a single buffered `application/json`
//      chat.completion (Content-Type application/json, object
//      "chat.completion") instead of an SSE stream of chat.completion.chunk
//      frames. opencode's agent loop always calls streamText(), so the
//      @ai-sdk/openai-compatible stream parser issues stream:true, gets a
//      non-SSE blob back, and fails — producing an empty assistant message
//      ("no review text returned from opencode").
//
// So we use @ai-sdk/openai-compatible against chat-completions (injecting
// service_tier=flex via a wrapped fetch) for the clean content shape, and
// layer a LanguageModelV3 shim that turns doStream() into doGenerate() — the
// NON-streaming path, which flex handles correctly — then re-emits the single
// result as a synthetic stream so opencode's streamText() is satisfied.
//
// This is the same fake-stream shim shape the autobatcher attempt used, but
// over a fundamentally healthier transport: chat-completions (phase-1 content
// shape) instead of the batch submit/poll dance that perturbed model
// behaviour. The only cost vs phase 1 is flex-tier per-call latency and the
// loss of token-by-token streaming — irrelevant for a bot that posts a single
// final review.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";

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

  // Inject service_tier into chat-completions request bodies. The shim below
  // only ever issues non-streaming (doGenerate) calls, so we never send a
  // stream:true request to flex — sidestepping the buffered-JSON-vs-SSE
  // mismatch entirely.
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

  const wrapModel = (modelId: string) => fakeStream(provider.chatModel(modelId));

  // opencode's provider loader calls `.languageModel(id)`; expose both names
  // plus the embedding accessors so the loader finds whichever it asks for.
  const wrapper: any = (modelId: string) => wrapModel(modelId);
  wrapper.languageModel = wrapModel;
  wrapper.chatModel = wrapModel;
  wrapper.textEmbeddingModel = (modelId: string) =>
    provider.textEmbeddingModel(modelId);
  wrapper.embeddingModel = (modelId: string) =>
    provider.textEmbeddingModel(modelId);
  return wrapper;
}

function fakeStream(inner: LanguageModelV3): LanguageModelV3 {
  return {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    doGenerate: (options: LanguageModelV3CallOptions) => inner.doGenerate(options),
    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const result: LanguageModelV3GenerateResult = await inner.doGenerate(options);
      const parts = generateResultToStreamParts(result);
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      });
      return {
        stream,
        request: result.request,
        response: result.response,
      };
    },
  };
}

function generateResultToStreamParts(
  result: LanguageModelV3GenerateResult,
): LanguageModelV3StreamPart[] {
  const parts: LanguageModelV3StreamPart[] = [];
  parts.push({ type: "stream-start", warnings: result.warnings ?? [] });

  let textIdx = 0;
  let reasoningIdx = 0;
  for (const c of result.content) {
    switch (c.type) {
      case "text": {
        const id = `text-${textIdx++}`;
        parts.push({ type: "text-start", id, providerMetadata: c.providerMetadata });
        if (c.text.length > 0) {
          parts.push({ type: "text-delta", id, delta: c.text });
        }
        parts.push({ type: "text-end", id });
        break;
      }
      case "reasoning": {
        const id = `reasoning-${reasoningIdx++}`;
        parts.push({ type: "reasoning-start", id, providerMetadata: c.providerMetadata });
        const text = (c as { text?: string }).text ?? "";
        if (text.length > 0) {
          parts.push({ type: "reasoning-delta", id, delta: text });
        }
        parts.push({ type: "reasoning-end", id });
        break;
      }
      case "tool-call": {
        // Although LanguageModelV3ToolCall is a valid StreamPart variant on
        // its own, the Vercel AI SDK's higher-level streamText() consumer
        // ONLY recognises a tool call as a real tool call when it has been
        // streamed as the tool-input-{start,delta,end} ceremony first. If
        // we emit the LanguageModelV3ToolCall directly without the preamble,
        // the SDK consumes it as an empty-content assistant turn and never
        // dispatches the tool — causing opencode to never see a tool to
        // execute, never accumulate a tool-result message, and effectively
        // restart the agent loop with no grounding on every turn. (See
        // docs/doubleword.md "Phase 2 — root-cause investigation".) Emit the
        // full start/delta/end sequence with the complete pre-existing input
        // serialised as a single delta, then pass the actual tool-call
        // through unchanged.
        const tc = c as LanguageModelV3ToolCall;
        parts.push({
          type: "tool-input-start",
          id: tc.toolCallId,
          toolName: tc.toolName,
          providerExecuted: tc.providerExecuted,
          dynamic: tc.dynamic,
          providerMetadata: tc.providerMetadata,
        });
        if (tc.input && tc.input.length > 0) {
          parts.push({ type: "tool-input-delta", id: tc.toolCallId, delta: tc.input });
        }
        parts.push({ type: "tool-input-end", id: tc.toolCallId });
        parts.push(tc);
        break;
      }
      // The StreamPart union accepts these content types directly — pass through.
      case "tool-result":
      case "tool-approval-request":
      case "file":
      case "source":
        parts.push(c as LanguageModelV3StreamPart);
        break;
    }
  }

  parts.push({
    type: "finish",
    usage: result.usage,
    finishReason: result.finishReason,
    providerMetadata: result.providerMetadata,
  });
  return parts;
}
