#!/usr/bin/env bun
// Cross-compiles the shim into single-file binaries for the linux targets we deploy on.
// Mirrors the opencode build pattern so the resulting Docker image only needs alpine + git + gh + ripgrep.

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(dir)

const targets = [
  { name: "linux-x64-musl", target: "bun-linux-x64-musl" },
  { name: "linux-arm64-musl", target: "bun-linux-arm64-musl" },
] as const

for (const t of targets) {
  const out = `dist/pr-review-shim-${t.name}/bin/pr-review-shim`
  console.log(`building ${t.name} -> ${out}`)
  await $`bun build src/index.ts --compile --target=${t.target} --outfile ${out}`
}

console.log("done")
