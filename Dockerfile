# Geocoder as a self-hosted web page. The app is already entirely client-side - geocoding
# happens in the visitor's browser - so the container is nothing but a static file server.
#
#   docker compose up -d --build        then open http://<host>:8231
#
# The place data is downloaded from the GitHub release at build time rather than copied from
# the build context, because it is not in the repository (see README). Pin a version with
#   docker compose build --build-arg DATA_URL=https://github.com/justinfritts/geocoder/releases/download/v0.2.0/geocoder-data.zip

# ---- app: rebuild the single HTML file from src/, so the image always matches the source
FROM node:22-alpine AS app
WORKDIR /build
COPY package.json ./
COPY scripts/build-app.mjs scripts/
COPY src/ src/
RUN node scripts/build-app.mjs

# ---- data: fetch the gazetteer and pre-compress every shard
FROM alpine:3.20 AS data
ARG DATA_URL=https://github.com/justinfritts/geocoder/releases/latest/download/geocoder-data.zip
RUN apk add --no-cache unzip
WORKDIR /build
ADD ${DATA_URL} geocoder-data.zip
# 288 MB of shards gzip to about a third of that. Only the .gz files are kept: nginx serves
# them as-is to every browser (all of which accept gzip) and decompresses on the fly for the
# rare client that does not, so the image does not carry the data twice.
RUN unzip -q geocoder-data.zip \
 && test -f data/index.js \
 && gzip -9 data/*.js

# ---- serve
FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=app /build/dist/geocoder.html /usr/share/nginx/html/
COPY dist/ATTRIBUTION.txt /usr/share/nginx/html/
COPY --from=data /build/data /usr/share/nginx/html/data
EXPOSE 80
HEALTHCHECK --interval=60s --timeout=5s CMD wget -q --spider http://127.0.0.1/ || exit 1
