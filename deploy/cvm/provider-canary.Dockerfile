FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:provider-canary

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 zaoshi-canary \
  && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin zaoshi-canary \
  && mkdir -p /var/lib/zaoshi/execution \
  && chown 10001:10001 /var/lib/zaoshi/execution \
  && chmod 0700 /var/lib/zaoshi/execution
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/dist-provider-canary/provider-canary.mjs /app/provider-canary.mjs
COPY --from=build --chown=10001:10001 /app/node_modules/@img/ /app/node_modules/@img/
COPY --from=build --chown=0:0 /app/drizzle/ /app/drizzle/

USER 10001:10001
ENTRYPOINT ["node", "/app/provider-canary.mjs"]
