# The hosted demo: one process that serves the page, plays Scout and the sellers, and runs the indexer.
# Contracts are not built here; the deployment record names contracts that are already on the network.
FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/x402/package.json packages/x402/
COPY packages/mcp/package.json packages/mcp/
COPY services/submitter/package.json services/submitter/
COPY services/verifier/package.json services/verifier/
COPY services/indexer/package.json services/indexer/
COPY apps/demo/package.json apps/demo/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY services services
COPY apps apps
RUN npm run build

FROM node:24.22.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/x402/package.json packages/x402/
COPY packages/mcp/package.json packages/mcp/
COPY services/submitter/package.json services/submitter/
COPY services/verifier/package.json services/verifier/
COPY services/indexer/package.json services/indexer/
COPY apps/demo/package.json apps/demo/
# What runs in the browser was bundled by the build; only what the server needs is installed here.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/x402/dist packages/x402/dist
COPY --from=build /app/services/verifier/dist services/verifier/dist
COPY --from=build /app/services/indexer/dist services/indexer/dist
COPY --from=build /app/apps/demo/dist apps/demo/dist
# Public addresses only. Keys are given as secrets when the container starts.
COPY deployments/testnet/demo.json deployments/testnet/demo.json

# Which keys to use is said by reference when the container starts (see fly.toml); none is in the image.
ENV DEMO_HOST=0.0.0.0 \
    DEMO_PORT=8080 \
    DEMO_DEPLOYMENT=/app/deployments/testnet/demo.json \
    DEMO_STATE_DIRECTORY=/data
COPY deployments/docker/entrypoint.sh /usr/local/bin/demo-entrypoint
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
# The entrypoint hands the mounted state directory to the `node` user and runs the server as that user.
ENTRYPOINT ["demo-entrypoint"]
CMD ["node", "apps/demo/dist/server/index.js"]
