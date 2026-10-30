# Claude Code with Remote Control, in one container.
#   docker build -t claude-code .
#   docker run -d --name cc -p 8080:8080 -v cc-data:/data claude-code
#   docker logs -f cc        # → open the CONNECT link, sign in, then use claude.ai/code or the Claude app
FROM node:22-bookworm-slim

# Pinned so a rebuild never changes behaviour silently; bump deliberately.
ARG CLAUDE_CODE_VERSION=2.1.314

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git curl ripgrep jq python3 python3-venv python3-pip make g++ procps less \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force \
 && mkdir -p /data /app && chown node:node /data \
 && git config --system init.defaultBranch main

WORKDIR /app
COPY server.mjs ./

# Everything that must survive a restart (the Claude sign-in, the work) is under /data.
# No secrets in the image or its env: you sign in with your own Claude subscription at runtime.
USER node
ENV HOME=/data/home WORKDIR=/data/work PORT=8080 NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "/app/server.mjs"]
