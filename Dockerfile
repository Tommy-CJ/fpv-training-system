# syntax=docker/dockerfile:1.7

ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM node:24.12-bookworm AS betaflight-modern
ARG NPM_REGISTRY
ENV HUSKY=0
WORKDIR /build
COPY vendor/betaflight-configurator/package.json vendor/betaflight-configurator/package-lock.json ./
RUN npm ci --registry="${NPM_REGISTRY}"
COPY vendor/betaflight-configurator/ ./
# Betaflight's Vite config embeds a Git revision. The deployment build context
# intentionally excludes nested .git directories, so create a harmless local
# build revision here.
RUN git init \
    && git config user.email "build@fpv.local" \
    && git config user.name "FPV Build" \
    && git commit --allow-empty -m "container build" \
    && npm run build \
    && test -f /build/src/dist/index.html

FROM node:20.10-bookworm AS betaflight-legacy
ARG NPM_REGISTRY
ENV HUSKY=0
WORKDIR /build
COPY vendor/betaflight-configurator-10.10.0/package.json vendor/betaflight-configurator-10.10.0/yarn.lock ./
RUN corepack enable \
    && yarn config set registry "${NPM_REGISTRY}" \
    && yarn install --frozen-lockfile
COPY vendor/betaflight-configurator-10.10.0/ ./
RUN git init \
    && git config user.email "build@fpv.local" \
    && git config user.name "FPV Build" \
    && git commit --allow-empty -m "container build" \
    && yarn build \
    && test -f /build/src/dist/index.html

FROM node:24.12-bookworm AS app-build
ARG NPM_REGISTRY
ENV HUSKY=0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry="${NPM_REGISTRY}"
COPY . .
RUN npm run build \
    && test -f /app/dist/index.html

FROM node:24.12-bookworm AS app-production-dependencies
ARG NPM_REGISTRY
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry="${NPM_REGISTRY}" \
    && npm cache clean --force

FROM node:24.12-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

COPY --from=app-production-dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json server.js ./
COPY server ./server
COPY --from=app-build /app/dist ./dist
COPY --from=betaflight-modern /build/src/dist ./betaflight-dist
COPY --from=betaflight-legacy /build/src/dist ./betaflight-legacy-dist

RUN mkdir -p /app/data/uploads/tracks

EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
