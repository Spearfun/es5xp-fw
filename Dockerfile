FROM debian:bookworm-slim
WORKDIR /build
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash bzip2 ca-certificates curl fakeroot \
      gcc libc6-dev make patch python3 tar zstd \
      zlib1g-dev liblzma-dev \
 && rm -rf /var/lib/apt/lists/*\
    && groupadd --system builder \
    && useradd --system \
      --gid builder \
      --home-dir /build \
      --create-home \
      --shell /bin/bash \
      builder \
 && mkdir -p /build/vendor \
 && curl -fsSL \
      'https://dl.ui.com/firmwares/edgemax/EdgeSwitchXP/v2.4.1/SW.v2.4.1.7.260715.1150.bin' \
      -o /build/vendor/SW.v2.4.1.7.260715.1150.bin
COPY --chown=builder:builder . .
RUN mkdir -p /build/out/release \
 && chown -R builder:builder /build
USER builder
ENTRYPOINT ["/bin/bash", "build.sh"]
