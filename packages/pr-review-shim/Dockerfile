# Combined Docker image for the COR-364 PR-review experiment harness.
#
# Bundles the prebuilt opencode binary, the pr-review-shim binary, the
# opencode.json provider config, and the docs into a minimal alpine image.
# Two services (opencode-server, pr-review-shim) deployed from the same
# image via docker-compose; the entrypoint switches based on the command.
#
# Build context must be the opencode repo root (so the COPY paths work).
# Build the binaries first via:
#   (cd packages/opencode && bun run build)
#   (cd packages/pr-review-shim && bun run build)
# then:
#   docker build -f packages/pr-review-shim/Dockerfile -t pr-review-harness .

FROM alpine AS base
ARG TARGETARCH

RUN apk add --no-cache \
      ca-certificates \
      git \
      github-cli \
      libgcc \
      libstdc++ \
      ripgrep \
      tini

WORKDIR /app

# opencode binary (built outside Docker).
FROM base AS opencode-amd64
COPY packages/opencode/dist/opencode-linux-x64-baseline-musl/bin/opencode /usr/local/bin/opencode

FROM base AS opencode-arm64
COPY packages/opencode/dist/opencode-linux-arm64-musl/bin/opencode /usr/local/bin/opencode

FROM opencode-${TARGETARCH} AS final

# pr-review-shim binary (also built outside Docker).
COPY packages/pr-review-shim/dist/pr-review-shim-linux-x64-musl/bin/pr-review-shim /usr/local/bin/pr-review-shim-x64
COPY packages/pr-review-shim/dist/pr-review-shim-linux-arm64-musl/bin/pr-review-shim /usr/local/bin/pr-review-shim-arm64
RUN if [ "${TARGETARCH}" = "amd64" ]; then \
      mv /usr/local/bin/pr-review-shim-x64 /usr/local/bin/pr-review-shim && \
      rm /usr/local/bin/pr-review-shim-arm64; \
    else \
      mv /usr/local/bin/pr-review-shim-arm64 /usr/local/bin/pr-review-shim && \
      rm /usr/local/bin/pr-review-shim-x64; \
    fi

# Project config + docs bundled into the image so the opencode server picks them up.
COPY opencode.json /app/opencode.json
COPY docs/doubleword.md /app/docs/doubleword.md

# Sanity check both binaries during build.
RUN opencode --version && pr-review-shim --help 2>&1 | head -1 || true

COPY packages/pr-review-shim/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["opencode-server"]
