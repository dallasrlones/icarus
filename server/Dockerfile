# Server image: compiles TypeScript to JS, ships only what's needed at runtime.
# cursor-agent is installed inside the image so the binary is Linux-native;
# auth state is mounted in from the host (see docker-compose.yml).

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# node-gyp needs Python + toolchain to compile node-pty on linux-arm64 when no prebuild exists.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Base tooling + Docker CLI + compose plugin. The Docker daemon stays on the
# host; we just need the client inside the container to talk to the bind-mounted
# /var/run/docker.sock. cursor-agent is installed afterwards.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates git gnupg sqlite3 \
      python3 make g++ \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsS https://cursor.com/install | bash \
 && ln -sf /root/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
 && ln -sf /root/.local/bin/agent /usr/local/bin/agent \
 && cursor-agent --version \
 && docker --version \
 && docker compose version

ENV NODE_ENV=production \
    PORT=4000 \
    CURSOR_BIN=cursor-agent \
    CURSOR_CWD=/workspace

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist

# Auth and workspace dirs are populated via bind mounts at run time.
RUN mkdir -p /workspace /root/.config/cursor-agent /root/.cursor

EXPOSE 4000
CMD ["node", "dist/index.js"]
