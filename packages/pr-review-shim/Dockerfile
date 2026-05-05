# Single-arch (linux/amd64) image for the COR-364 PR-review experiment harness.
#
# Bundles the prebuilt opencode binary, the prebuilt pr-review-shim binary, the
# opencode.json provider config, and the docs into a minimal alpine image.
# The shim self-supervises opencode-server as a child process so the runtime is
# a single process tree behind one entrypoint — friendly to Cloud Run.
#
# For two-container local dev (docker-compose), override the entrypoint to run
# `opencode serve` in one container and `pr-review-shim` in the other, and set
# OPENCODE_SERVER_URL on the shim so it doesn't try to spawn its own opencode.
#
# Build context must be the opencode repo root. Build the binaries first via:
#   (cd packages/opencode && bun run build)
#   (cd packages/pr-review-shim && bun run build)
# then:
#   docker build --platform linux/amd64 -f packages/pr-review-shim/Dockerfile \
#     -t pr-review-harness .

FROM alpine

RUN apk add --no-cache \
      ca-certificates \
      curl \
      git \
      github-cli \
      libgcc \
      libstdc++ \
      ripgrep \
      tini

WORKDIR /app

# Pre-built binaries (linux x64-musl) for amd64 Cloud Run targets.
COPY packages/opencode/dist/opencode-linux-x64-baseline-musl/bin/opencode /usr/local/bin/opencode
COPY packages/pr-review-shim/dist/pr-review-shim-linux-x64-musl/bin/pr-review-shim /usr/local/bin/pr-review-shim

# Project config + docs bundled into the image so the opencode server picks
# them up at runtime regardless of the working directory passed via
# x-opencode-directory.
COPY opencode.json /app/opencode.json
COPY docs/doubleword.md /app/docs/doubleword.md

# Sanity check binaries during build — fail-fast if either is broken.
RUN opencode --version

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pr-review-shim"]
