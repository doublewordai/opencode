// Phase-4 wrapper: Open Responses API + service_tier=flex + background=true.
//
// Same plumbing as phase 3, with the inference call restructured for the
// 202+poll pattern:
//
//   1. POST /v1/responses with body { ..., service_tier: "flex", background: true }
//   2. Server returns 202 + { id, status: "queued" } immediately
//   3. We poll GET /v1/responses/{id} every pollIntervalMs until status
//      transitions out of "queued" / "in_progress"
//   4. Synthesize a 200 Response with the final polled body so the AI SDK
//      sees the same shape it would have seen from the non-background path
//
// The whole 202+poll dance lives inside the fetch wrapper so the AI SDK
// sees a single "synchronous" call. opencode's session loop is unchanged.
//
// Hypothesis under test (from COR-367): polling resolves both the
// client-side-batching-overload risk (phase 2) and the long-held-connection
// timeout risk (phase 3) — at the cost of restructuring the call site for
// non-blocking inference. The restructuring cost itself is recordable
// friction, since the AI SDK's stream contract was clearly designed for
// blocking calls.
//
// Streaming intentionally not supported on this transport — the polled
// final body is a single completed response object, and converting it
// back to an event-stream just to satisfy a pretend streaming contract
// would obscure what we're trying to measure. opencode's review agent
// doesn't depend on streaming for anything user-visible.

import { createOpenAI } from "@ai-sdk/openai";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "incomplete",
  "cancelled",
  "canceled",
  "expired",
]);

export interface DoublewordResponsesOptions {
  name?: string;
  apiKey?: string;
  baseURL?: string;
  serviceTier?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export function createDoubleword(opts: DoublewordResponsesOptions = {}) {
  const apiKey = opts.apiKey;
  const baseURL = opts.baseURL;
  const serviceTier = opts.serviceTier ?? "flex";
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 60 * 60 * 1000; // 1h, matches flex SLA

  const wrappedFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    const isResponsesPost =
      init?.method === "POST" &&
      url.includes("/responses") &&
      !url.match(/\/responses\/[^/?]+/);

    if (!isResponsesPost || !init?.body || typeof init.body !== "string") {
      return fetch(input as RequestInfo, init);
    }

    let body: any;
    try {
      body = JSON.parse(init.body);
    } catch {
      return fetch(input as RequestInfo, init);
    }
    body.service_tier = serviceTier;
    body.background = true;
    // background mode is incompatible with stream=true on the upstream API
    delete body.stream;

    const submitRes = await fetch(input as RequestInfo, {
      ...init,
      body: JSON.stringify(body),
    });
    if (!submitRes.ok && submitRes.status !== 202) {
      return submitRes;
    }

    const submitJson: any = await submitRes.clone().json().catch(() => null);
    const responseId: string | undefined = submitJson?.id;
    if (!responseId) {
      return submitRes;
    }

    const baseUrl = url.split("?")[0]!;
    const pollUrl = `${baseUrl}/${responseId}`;
    const headers: Record<string, string> = {};
    if (init.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        if (k.toLowerCase() !== "content-type") headers[k] = v;
      });
    }

    const deadline = Date.now() + pollTimeoutMs;
    let lastJson: any = submitJson;
    while (Date.now() < deadline) {
      const status: string | undefined = lastJson?.status;
      if (status && TERMINAL_STATUSES.has(status)) break;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const pollRes = await fetch(pollUrl, { method: "GET", headers });
      if (!pollRes.ok) {
        return pollRes;
      }
      lastJson = await pollRes.json();
    }

    return new Response(JSON.stringify(lastJson), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-doubleword-background-poll": "true",
      },
    });
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
