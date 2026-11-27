# The hosted demo: one process that serves the page, plays Scout and the sellers, and runs the indexer.
# Contracts are not built here; the deployment record names contracts that are already on the network.
FROM node:24.22.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/cli/package.json packages/cli/
COPY packages/x402/package.json packages/x402/
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

ENV DEMO_HOST=0.0.0.0 \
    DEMO_PORT=8080 \
    DEMO_DEPLOYMENT=/app/deployments/testnet/demo.json \
    DEMO_STATE_DIRECTORY=/data \
    DEMO_AGENT_KEY=env:SCOUT_AGENT_SECRET \
    DEMO_FUNDER_KEY=env:SCOUT_FUNDER_SECRET \
    DEMO_FACILITATOR_KEY=env:SCOUT_FACILITATOR_SECRET
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "apps/demo/dist/server/index.js"]
