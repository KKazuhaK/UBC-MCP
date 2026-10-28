FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG BUILD_VERSION=dev
ARG BUILD_COMMIT=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="ubc-mcp" \
      org.opencontainers.image.description="UBC course discovery MCP server (stdio)" \
      org.opencontainers.image.source="https://github.com/KKazuhaK/UBC-MCP" \
      org.opencontainers.image.version=$BUILD_VERSION \
      org.opencontainers.image.revision=$BUILD_COMMIT \
      org.opencontainers.image.created=$BUILD_TIME \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY LICENSE ./LICENSE
RUN mkdir -p /data && chown node:node /data
USER node
# stdio transport: run with `docker run -i`. There is no network listener, so no HEALTHCHECK.
ENTRYPOINT ["node", "dist/cli.js"]
