# syntax=docker/dockerfile:1.7
#
# The Starter CRM with the Node server, as one small image.
#
# Where it sits: build it from the starter root (`docker build -t starter-crm .`).
# Stage 1 builds the React app, stage 2 installs the server's production
# dependencies, and the last stage copies only what runs. The Python server has
# its own file at server/python/Dockerfile.
#
# What the image does and does not contain:
# - It runs as the unprivileged `node` user, listens on 0.0.0.0:8080 and has a
#   HEALTHCHECK on /healthz.
# - DC_ENV defaults to production here, so the image refuses the local-only
#   `dev` identity. Choose DC_IDENTITY (passcode or oidc) when you run it.
# - No Drop Cowboy Building Blocks code is in it. The browser loads those from
#   the CDN at run time. .dockerignore allows only the folders listed in the
#   COPY lines below, and the container leak check proves it.
# - Settings come from the environment (or `file` secrets under /run/secrets);
#   there is no .env inside the image.
#
# Base images are pinned by digest so a build is reproducible. Dependabot bumps
# the digest; to change it by hand, run `docker buildx imagetools inspect
# node:24-slim` and copy the top-level Digest.

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS react-build
WORKDIR /app
# The React app imports ../shared, so both folders are copied. Dependencies
# first, so a source change does not reinstall them.
COPY shared ./shared
COPY react/package.json react/package-lock.json ./react/
WORKDIR /app/react
RUN npm ci --no-audit --no-fund
COPY react ./
RUN npm run build

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS server-deps
WORKDIR /app/server/node
COPY server/node/package.json server/node/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production \
    DC_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STARTER_CRM_ROOT=/app
# Two fixes for what the vulnerability scan (.github/workflows/images.yml) reports:
# - The server never runs npm, npx or corepack, but npm ships its own copies of
#   dozens of packages, and the scan flags them. Removing them leaves nothing
#   to patch and nothing for an attacker who gets a shell to use.
# - Debian's security fixes land after the base image is built, so upgrade what
#   has one. This is the one step that is not reproducible by digest alone.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && apt-get update \
    && apt-get upgrade --yes \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --chown=node:node shared ./shared
COPY --chown=node:node vanilla ./vanilla
COPY --from=react-build --chown=node:node /app/react/dist ./react/dist
COPY --from=server-deps --chown=node:node /app/server/node/node_modules ./server/node/node_modules
COPY --chown=node:node server/node/package.json ./server/node/package.json
COPY --chown=node:node server/node/src ./server/node/src
COPY --chown=node:node server/migrations ./server/migrations
COPY --chown=node:node server/schemas ./server/schemas
# Where DC_STORE=sqlite keeps its file; mount a volume here to keep events across container replacements.
RUN mkdir /data && chown 1000:1000 /data
ENV DC_SQLITE_PATH=/data/starter-crm.sqlite

USER 1000:1000
WORKDIR /app/server/node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# `node` itself, not `npm start`, so SIGTERM reaches the server and the
# graceful drain (DC_SHUTDOWN_GRACE_SECONDS) runs.
CMD ["node", "src/index.js"]
