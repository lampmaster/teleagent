# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim AS runtime
# curl and procps (ps) are what the agent's exec tool reaches for; see skills/start-day.md.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl procps tzdata \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY skills ./skills
# /app/data holds the bot's history, metrics and flags; /app/benchmark-data keeps
# the benchmark's own copies so a benchmark can never touch real conversations.
RUN mkdir -p /app/data /app/benchmark-data && chown node:node /app/data /app/benchmark-data

USER node
# Overridden by the dashboard and benchmark services, which share this image.
CMD ["node", "dist/main.js"]
