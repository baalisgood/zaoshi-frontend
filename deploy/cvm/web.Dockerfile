FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV ZAOSHI_BUILD_TARGET=cvm
RUN npm run build:cvm

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 zaoshi-web \
  && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin zaoshi-web
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/dist/standalone/ /app/
COPY --from=build --chown=0:0 /app/drizzle/ /app/drizzle/

ENV NODE_ENV=production \
  PORT=3000 \
  HOST=0.0.0.0 \
  ZAOSHI_RUNTIME=node \
  ZAOSHI_SQLITE_PATH=/var/lib/zaoshi/db/zaoshi.sqlite \
  ZAOSHI_OBJECT_ROOT=/var/lib/zaoshi/objects \
  ZAOSHI_MIGRATIONS_DIR=/app/drizzle

USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["flock", "-n", "-F", "-E", "73", "/var/lib/zaoshi/db/.web.lock", "node", "/app/server.js"]
