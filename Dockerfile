FROM python:3.12-slim

# Kopplar GHCR-paketet till repot (README/källa syns på paketsidan).
LABEL org.opencontainers.image.source="https://github.com/cgillinger/ytmusic-dl" \
      org.opencontainers.image.description="Musik till spelaren — självhostad YouTube Music-nedladdare för familjens NAS"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Deno: JavaScript-runtime som yt-dlp:s utmaningslösare (EJS) kräver för
# inloggade YouTube-sessioner (signatur/n-challenge). TARGETARCH sätts av
# buildx vid multi-arch-bygge; tomt (vanlig docker build) → x86_64.
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
      arm64) deno_arch=aarch64-unknown-linux-gnu ;; \
      *)     deno_arch=x86_64-unknown-linux-gnu ;; \
    esac \
    && curl -fsSL "https://github.com/denoland/deno/releases/latest/download/deno-${deno_arch}.zip" \
      -o /tmp/deno.zip \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && rm /tmp/deno.zip \
    && chmod +x /usr/local/bin/deno

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV HOMES_DIR=/homes \
    DATA_DIR=/data \
    PORT=8201

EXPOSE 8201
CMD ["/entrypoint.sh"]
