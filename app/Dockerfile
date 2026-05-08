# Frontend image: Expo dev server serving the web target on port 8081.
# Native (iOS/Android) targets are still launched from the host with `npm start`.

FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development
# Tell Metro to advertise localhost so URLs work when the browser hits the
# port we publish on the host. CI=1 disables the interactive Expo prompt.
ENV REACT_NATIVE_PACKAGER_HOSTNAME=localhost
ENV CI=1

# Native dev tooling that some Expo deps poke at during install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .

EXPOSE 8081
CMD ["npx", "expo", "start", "--web", "--port", "8081", "--host", "lan"]
