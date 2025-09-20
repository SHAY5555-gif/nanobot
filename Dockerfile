# syntax=docker/dockerfile:1

# ---------- Build stage: UI + Go binary ----------
FROM golang:1.22-alpine AS build

# Install Node.js + pnpm for building the SvelteKit UI
RUN apk add --no-cache nodejs npm git curl && \
    corepack enable && corepack prepare pnpm@8.15.4 --activate

WORKDIR /app

# Go deps first (better layer caching)
COPY go.mod go.sum ./
RUN go mod download

# Copy the rest of the repo
COPY . .

# Build the UI to ui/dist (embedded later via //go:embed all:*dist)
WORKDIR /app/ui
# Prefer frozen lockfile if present; fall back to install
RUN pnpm install --frozen-lockfile || pnpm install
RUN pnpm run build && mv build dist

# Build the Go binary with UI embedded
WORKDIR /app
# Ensure CGO off -> static binary, good for minimal base image
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /out/nanobot ./

# ---------- Runtime stage ----------
FROM cgr.dev/chainguard/wolfi-base:latest

# Copy the binary from the build stage
COPY --from=build /out/nanobot /usr/local/bin/nanobot

# Create non-root user and data dir
RUN adduser -D -s /bin/sh nanobot && \
    mkdir -p /data && chown nanobot:nanobot /data

# Add a tiny entrypoint that respects Vercel/OCI PORT
RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'if [ -n "$PORT" ]; then' \
  '  export NANOBOT_RUN_LISTEN_ADDRESS="0.0.0.0:${PORT}"' \
  'fi' \
  'exec /usr/local/bin/nanobot run' > /usr/local/bin/docker-entrypoint.sh && \
  chmod +x /usr/local/bin/docker-entrypoint.sh

USER nanobot

# Service configuration
ENV NANOBOT_STATE=/data/nanobot.db
ENV NANOBOT_RUN_HEALTHZ_PATH=/api/healthz
# default for local runs; in Vercel/OCI entrypoint overrides with $PORT if present
ENV NANOBOT_RUN_LISTEN_ADDRESS=0.0.0.0:8080

# Persisted data
VOLUME ["/data"]

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
