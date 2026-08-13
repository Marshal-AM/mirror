# TypeScript AI-agent FCE image — two-process topology (tee-node + extension).
# Build context is fce-ai-agent (NOT fce-matching-engine).
#
# scripts/start-services.sh builds the shared tee-node base automatically.

ARG TEE_NODE_REF
FROM local/tee-node-base:${TEE_NODE_REF} AS node

FROM node:22-trixie AS ext-builder

WORKDIR /ext

COPY --chmod=644 --chown=0:0 typescript/package.json typescript/package-lock.json ./
RUN npm ci

COPY --chmod=644 --chown=0:0 typescript/tsconfig.json ./
COPY --chmod=644 --chown=0:0 typescript/src/ ./src/
RUN npm run build

RUN npm prune --omit=dev

FROM debian:trixie-slim AS runtime

ARG SOURCE_DATE_EPOCH

WORKDIR /app

RUN \
  --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  if [ "${SOURCE_DATE_EPOCH:-0}" -gt 0 ] 2>/dev/null; then \
    snapshot="$(/bin/bash -euc "printf \"%(%Y%m%dT%H%M%SZ)T\n\" \"${SOURCE_DATE_EPOCH}\"")" && \
    sed -i -e '/Types: deb/ a\Snapshot: true' /etc/apt/sources.list.d/debian.sources && \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' >/etc/apt/apt.conf.d/keep-cache && \
    apt-get install --update --snapshot "${snapshot}" -o Acquire::Check-Valid-Until=false -o Acquire::https::Verify-Peer=false -y ca-certificates && \
    apt-get install --snapshot "${snapshot}" -y ca-certificates nodejs && \
    rm -rf /var/log/* /var/cache/ldconfig/aux-cache; \
  else \
    apt-get update && apt-get install -y ca-certificates nodejs && \
    rm -rf /var/lib/apt/lists/* /var/log/* /var/cache/ldconfig/aux-cache; \
  fi

COPY --chmod=755 --chown=0:0 --from=node /app/server /app/server
COPY --chmod=644 --chown=0:0 --from=node /app/assets/google_confidential_space_root.crt /app/assets/google_confidential_space_root.crt

COPY --chmod=644 --chown=0:0 --from=ext-builder /ext/dist /app/extension/dist
COPY --chmod=644 --chown=0:0 --from=ext-builder /ext/node_modules /app/extension/node_modules
COPY --chmod=644 --chown=0:0 --from=ext-builder /ext/package.json /app/extension/package.json

RUN if [ "${SOURCE_DATE_EPOCH:-0}" -gt 0 ] 2>/dev/null; then find /app -exec touch -h -d @${SOURCE_DATE_EPOCH} {} +; fi

ENV MODE=1 CONFIG_PORT=5501 SIGN_PORT=7701 EXTENSION_PORT=7702

USER 0:0

LABEL "tee.launch_policy.allow_env_override"="LOG_LEVEL,PROXY_URL,INITIAL_OWNER,EXTENSION_ID,CHAIN_URL,MODE,CONFIG_PORT,SIGN_PORT,EXTENSION_PORT"

EXPOSE 5501 7701 7702

CMD ["/bin/bash", "-c", "/app/server & SERVER_PID=$!; node /app/extension/dist/main.js & EXT_PID=$!; wait -n $SERVER_PID $EXT_PID; kill -TERM $SERVER_PID $EXT_PID 2>/dev/null; exit 1"]
