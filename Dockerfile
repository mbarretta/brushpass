# syntax=docker/dockerfile:1
# Base image digests pinned 2026-04-09. Update intentionally when patching base images.
# Refresh with: docker buildx imagetools inspect cgr.dev/barretta/node:25-dev
FROM cgr.dev/barretta/node:26-dev@sha256:ce637eba5bfabd5e3bcd87a60ddd8373beb5410c4e6917a69742bd78854825cb AS builder
USER root
RUN apk add --no-cache gcc make python3
USER 65532
WORKDIR /app
COPY --chown=65532:65532 package*.json ./
RUN npm ci
COPY --chown=65532:65532 . .
ENV GCS_BUCKET=build-placeholder
ARG COMMIT_SHA=dev
ENV NEXT_PUBLIC_COMMIT_SHA=$COMMIT_SHA
RUN npm run build

# Prune devDependencies out of the builder's node_modules before it's copied
# into the runner stage, in a dedicated intermediate stage so the pruned tree
# never has to be reconciled against COPY --from's own layer caching. `next
# start` still needs to load next.config.ts at boot (Next transpiles it via its
# own bundled SWC bindings, not the `typescript` package — verified empirically
# by booting this exact pruned image and confirming `typescript` is absent from
# node_modules yet `next start` still parses next.config.ts and serves `/`).
FROM builder AS pruner
RUN npm prune --omit=dev
# Fail the build if the native modules didn't compile or didn't survive the
# prune. npm 12 (bundled with Node >= 26) blocks dependency install scripts
# not covered by package.json's `allowScripts` — with a WARNING and exit 0 —
# so `npm ci` can "succeed" while silently shipping better-sqlite3 with no
# compiled binding (exactly what broke every DB route in production on
# 2026-08-14). unrs-resolver is deliberately NOT allowlisted: it is dev-only
# lint tooling with a JS fallback and never reaches the runner image.
RUN node -e "new (require('better-sqlite3'))(':memory:'); require('sharp'); console.log('native modules OK')"

FROM cgr.dev/barretta/node:26-slim@sha256:2d287c6de78e338ba9a63f8309d27d7e4294e2edf1ad154cb823cb857cf7a043 AS runner
USER 65532
WORKDIR /app
COPY --from=builder --chown=65532:65532 /app/.next ./.next
COPY --from=pruner --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/package.json ./package.json
COPY --from=builder --chown=65532:65532 /app/public ./public
COPY --from=builder --chown=65532:65532 /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=65532:65532 /app/src ./src
COPY --from=builder --chown=65532:65532 /app/scripts ./scripts
ENV DATABASE_PATH=/data/fileshare.db
ENV NODE_ENV=production
EXPOSE 3000
CMD ["./node_modules/next/dist/bin/next", "start"]
