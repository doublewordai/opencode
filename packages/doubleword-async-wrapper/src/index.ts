// Phase-2 wrapper for opencode's provider loader.
//
// opencode's non-bundled provider loader (packages/opencode/src/provider/provider.ts:1544)
// resolves a factory by `Object.keys(mod).find((key) => key.startsWith("create"))`.
// `@doubleword/vercel-ai` exports `createDoubleword` (sync), `createDoublewordAsync`
// (1h flex via autobatcher), and `createDoublewordBatch` (24h batch). The first
// "create"-prefixed key is `createDoubleword`, which is the sync provider — the
// opposite of what phase 2 wants to test.
//
// Re-exporting `createDoublewordAsync` under the name `createDoubleword` makes
// the loader pick the autobatcher path. This whole module exists only because
// opencode has no config-level factory selector — see Phase 2 friction notes.
export { createDoublewordAsync as createDoubleword } from "@doubleword/vercel-ai";
