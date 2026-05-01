ARG FOUNDRY_VERSION=13

FROM node:24-alpine AS deps
WORKDIR /build
COPY oidc/package.json oidc/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM felddy/foundryvtt:${FOUNDRY_VERSION}
USER root
COPY oidc /opt/oidc
COPY foundry-module /opt/oidc/foundry-module
COPY --from=deps /build/node_modules /opt/oidc/node_modules
RUN chown -R node:node /opt/oidc \
 && sed -i "s|^ENV_VAR_PASSLIST_REGEX=.*|ENV_VAR_PASSLIST_REGEX='^HOME\$ ^NODE_.+\$ ^OIDC_.+\$ ^TZ\$'|" /home/node/launcher.sh \
 && grep -q '\^OIDC_' /home/node/launcher.sh
ENV NODE_OPTIONS="--import=file:///opt/oidc/shim.mjs"
USER node
