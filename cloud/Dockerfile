# syntax=docker/dockerfile:1
FROM node:24-slim AS builder
WORKDIR /repo

COPY cloud/package.json cloud/package-lock.json ./cloud/
RUN npm --prefix cloud ci

COPY cloud/build.mjs cloud/tsconfig.json ./cloud/
COPY cloud/migrations ./cloud/migrations
COPY cloud/src ./cloud/src
RUN npm --prefix cloud run build

FROM node:24-slim AS runtime
WORKDIR /app/cloud

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8788
ENV HF_HOME=/data/hf-cache
ENV TRANSFORMERS_CACHE=/data/hf-cache

COPY cloud/package.json cloud/package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data/hf-cache && chown -R node:node /app /data

COPY --from=builder --chown=node:node /repo/cloud/dist ./dist

USER node
EXPOSE 8788
CMD ["node", "dist/server.mjs", "serve"]
