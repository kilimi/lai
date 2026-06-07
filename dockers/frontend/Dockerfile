# Build SPA; nginx serves static files. API URL is baked at build time (VITE_API_URL).
# Use Debian-based Node (glibc): optional peer `canvas` (from jsdom/vitest) has prebuilds for
# linux-gnu, unlike Alpine/musl where npm falls back to node-gyp + Python.
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm install

COPY . .

ARG VITE_API_URL=SAME_ORIGIN
ARG VITE_APP_VERSION=0.1.0
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_APP_VERSION=$VITE_APP_VERSION

RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
