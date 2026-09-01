# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

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
RUN mkdir -p /app/data && chown node:node /app/data

USER node
CMD ["node", "dist/main.js"]
