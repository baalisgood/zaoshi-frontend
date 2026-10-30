FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:consumer

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 zaoshi-worker \
  && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin zaoshi-worker
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/dist-consumer/consumer.mjs /app/consumer.mjs
COPY --from=build --chown=10001:10001 /app/node_modules/@img/ /app/node_modules/@img/
USER 10001:10001
ENTRYPOINT ["flock", "-n", "-F", "-E", "73", "/var/lib/zaoshi/.consumer.lock", "node", "/app/consumer.mjs"]
