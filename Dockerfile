# ── Build stage ──────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# ── Production stage ─────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# HF Spaces expects port 7860
ENV PORT=7860
EXPOSE 7860

# Run the full server (with docs at /docs)
CMD ["node", "dist/src/server.js"]
