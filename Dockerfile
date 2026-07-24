# syntax=docker/dockerfile:1
# Base image digests pinned 2026-04-09. Update intentionally when patching base images.
# Refresh with: docker buildx imagetools inspect cgr.dev/barretta/node:25-dev
FROM cgr.dev/barretta/node:25-dev@sha256:783e2dbad67ad30dc4f986082e815412a7578ee3316116ddaca28e8167d38237 AS builder
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

FROM cgr.dev/barretta/node:25-slim@sha256:e8a26d14ab75eef6646edec7e7de7b922ee06e2a285c86777bcaa5c4cd82bc0b AS runner
WORKDIR /app
COPY --from=builder --chown=65532:65532 /app/.next ./.next
COPY --from=builder --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/package.json ./package.json
COPY --from=builder --chown=65532:65532 /app/public ./public
COPY --from=builder --chown=65532:65532 /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=65532:65532 /app/src ./src
COPY --from=builder --chown=65532:65532 /app/scripts ./scripts
ENV DATABASE_PATH=/data/fileshare.db
ENV NODE_ENV=production
EXPOSE 3000
CMD ["./node_modules/next/dist/bin/next", "start"]
