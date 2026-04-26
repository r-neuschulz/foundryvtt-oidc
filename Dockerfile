ARG FOUNDRY_VERSION=release

FROM node:24-alpine AS deps
WORKDIR /build
COPY oidc/package.json oidc/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM felddy/foundryvtt:${FOUNDRY_VERSION}
USER root
COPY oidc /opt/oidc
COPY --from=deps /build/node_modules /opt/oidc/node_modules
RUN chown -R node:node /opt/oidc
ENV NODE_OPTIONS="--import file:///opt/oidc/shim.mjs"
USER node
