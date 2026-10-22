# API and BullMQ worker image (same build, different command). Build context: repository root.
#   docker build -f services/api/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/api/package.json services/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci --workspace=@autonomous-engineer/contracts --workspace=@autonomous-engineer/api --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY services/api services/api
RUN npm run build:contracts && npm run build --workspace=@autonomous-engineer/api

FROM node:24-bookworm-slim
# git: the worker builds verification requests from the repository history
RUN apt-get update && apt-get install -y --no-install-recommends git openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /repos && chown node:node /repos
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
# Demo repository builder (used by the stack's repos-init service)
COPY --chown=node:node scripts/demo /app/scripts/demo
COPY --chown=node:node services/agent-service/tests/fixtures/demo_app /app/demo/fixtures/demo_app
COPY --chown=node:node services/agent-service/tests/fixtures/diffs /app/demo/fixtures/diffs
USER node
WORKDIR /app/services/api
EXPOSE 4000
# Applies pending migrations, then serves the API; the worker overrides the command
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/server.js"]
