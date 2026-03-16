FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
RUN npm run build && mkdir -p /app/public

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create temp directory for workflow files
RUN mkdir -p /tmp/zyk

# Copy built output
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# CRITICAL: Copy bin/worker-process.js to /app/bin/
# This file is NOT compiled by Next.js — it must be present as-is
COPY --from=builder /app/bin ./bin

# node_modules needed by worker subprocess for Hatchet SDK resolution
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
