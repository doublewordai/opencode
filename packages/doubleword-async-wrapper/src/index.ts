// Phase-2 wrapper, take 2: chat-completions through Doubleword's autobatcher
// (createDoublewordAsync — 1h flex tier) with a fake-streaming shim layered on
// top so opencode's streamText() calls succeed.
//
// The original phase-2 wrapper just re-exported `createDoublewordAsync` as
// `createDoubleword`. opencode's agent loop uses streamText; the autobatcher
// rejects streaming with "Streaming is not supported in batch mode. Use
// generateText() instead of streamText()." (See docs/doubleword.md "Phase 2
// results — autobatcher" for the original failure write-up.)
//
// This wrapper replaces the re-export with a LanguageModelV3 shim that:
//   - Delegates doGenerate() unchanged to the autobatcher's underlying model
//   - Implements doStream() by calling doGenerate() and emitting the result
//     as a single synthetic stream — text content as start/delta/end triplets,
//     tool-call / tool-result / file / source / tool-approval-request as
//     pass-through stream parts (the LanguageModelV3StreamPart union accepts
//     these types directly), and a final 'finish' event with usage + reason.
//
// This is a polite lie: opencode thinks it's getting a real stream, but the
// underlying provider returns the entire response in one batch. For an agent
// loop where each turn is one model call followed by tool execution, that's
// fine — the stream just emits one big chunk and ends. For UX where token-
// by-token streaming matters, this shim defeats the point.

import { createDoublewordAsync } from "@doubleword/vercel-ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

interface CreateDoublewordOptions {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  batchSize?: number;
  batchWindowSeconds?: number;
  pollIntervalSeconds?: number;
  completionWindow?: string;
}

export function createDoubleword(opts: CreateDoublewordOptions = {}) {
  // Pin completionWindow="1h" explicitly. createDoublewordAsync forwards
  // options.completionWindow through to autobatcher's AsyncOpenAI (see
  // @doubleword/vercel-ai dist/index.js:359). When this is undefined, the
  // underlying AsyncOpenAI client defaults to the 24h batch tier — not the
  // 1h flex tier the README documents. We want the 1h flex tier here, so
  // override explicitly. (Upstream bug to follow up on with the
  // @doubleword/vercel-ai maintainers.)
  //
  // batchSize=1 + batchWindowSeconds=1 eliminate the autobatcher's sequential-
  // loop overhead. opencode's agent loop is strictly sequential (each turn
  // waits for the previous turn's tool result), so there are never multiple
  // concurrent calls to batch together — the default batchWindowSeconds=10
  // would just add 10s of dead waiting per turn. Submitting immediately
  // (batchSize=1, batchWindowSeconds=1) makes the autobatcher behave like a
  // pass-through to the flex/async tier.
  const inner = createDoublewordAsync({
    completionWindow: "1h",
    batchSize: 1,
    batchWindowSeconds: 1,
    ...opts,
  });

  const wrapModel = (modelId: string) => fakeStream(inner.languageModel(modelId));

  const provider: any = (modelId: string) => wrapModel(modelId);
  provider.languageModel = wrapModel;
  provider.chatModel = wrapModel;
  provider.embeddingModel = (id: string) => inner.embeddingModel(id);
  provider.textEmbeddingModel = (id: string) => inner.textEmbeddingModel(id);
  provider.close = () => inner.close();
  return provider;
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
      // The StreamPart union accepts these content types directly — pass through.
      case "tool-call":
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
