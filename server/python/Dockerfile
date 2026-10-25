# syntax=docker/dockerfile:1.7
#
# The Starter CRM with the Python server, as one small image.
#
# Where it sits: build it from the STARTER ROOT, not from this folder, because
# the image also carries the front-ends:
#
#     docker build -f server/python/Dockerfile -t starter-crm-python .
#
# Stage 1 builds the React app, stage 2 installs the pinned Python
# dependencies into a virtualenv, and the last stage copies only what runs. The
# Node server has its own file at the starter root.
#
# What the image does and does not contain:
# - Gunicorn runs it (gunicorn.conf.py), as an unprivileged user, on
#   0.0.0.0:8080, with a HEALTHCHECK on /healthz. SIGTERM drains open event
#   streams within DC_SHUTDOWN_GRACE_SECONDS.
# - DC_ENV defaults to production, so the image refuses the local-only `dev`
#   identity. Choose DC_IDENTITY (passcode or oidc) when you run it.
# - No Building Blocks code. .dockerignore allows only the folders copied below.
# - Settings come from the environment or `file` secrets; no .env inside.
#
# Base images are pinned by digest. Dependabot bumps the digests. To change one by hand, run `docker buildx
# imagetools inspect python:3.13-slim` and copy the top-level Digest.

FROM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS react-build
WORKDIR /app
COPY shared ./shared
COPY react/package.json react/package-lock.json ./react/
WORKDIR /app/react
RUN npm ci --no-audit --no-fund
COPY react ./
RUN npm run build

FROM python:3.13-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS python-deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
COPY server/python/requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install -r /tmp/requirements.txt

FROM python:3.13-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DC_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STARTER_CRM_ROOT=/app
# Debian's security fixes land after the base image is built, so upgrade what
# has one. The vulnerability scan (.github/workflows/images.yml) gates on fixable
# findings, and this is the one step that is not reproducible by digest alone.
RUN apt-get update \
    && apt-get upgrade --yes \
    && rm -rf /var/lib/apt/lists/*
# Id 1000, the same as the Node image, so one set of mounted-secret permissions works for both.
RUN groupadd --gid 1000 starter && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin starter
WORKDIR /app
COPY --from=python-deps /opt/venv /opt/venv
COPY --chown=starter:starter shared ./shared
COPY --chown=starter:starter vanilla ./vanilla
COPY --from=react-build --chown=starter:starter /app/react/dist ./react/dist
COPY --chown=starter:starter server/python/starter_crm ./server/python/starter_crm
COPY --chown=starter:starter server/python/gunicorn.conf.py ./server/python/gunicorn.conf.py
COPY --chown=starter:starter server/migrations ./server/migrations
COPY --chown=starter:starter server/schemas ./server/schemas
# Where DC_STORE=sqlite keeps its file; mount a volume here to keep events across container replacements.
RUN mkdir /data && chown 1000:1000 /data
ENV DC_SQLITE_PATH=/data/starter-crm.sqlite

USER 1000:1000
WORKDIR /app/server/python
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import os, sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8080') + '/healthz', timeout=4).status == 200 else 1)"]
CMD ["gunicorn", "-c", "gunicorn.conf.py", "starter_crm.wsgi:app"]
