FROM debian:stable-slim

ARG LND_VERSION
ENV PATH=/opt/lnd:$PATH

RUN apt-get update -y \
  && apt-get install -y curl gosu wait-for-it \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

RUN SYS_ARCH="$(dpkg --print-architecture)" \
  && curl -SLO https://github.com/lightningnetwork/lnd/releases/download/v${LND_VERSION}/lnd-linux-${SYS_ARCH}-v${LND_VERSION}.tar.gz \
  && tar -xzf *.tar.gz \
  && mkdir /opt/lnd \
  && mv ./lnd-linux-${SYS_ARCH}-v${LND_VERSION}/* /opt/lnd \
  && rm *.tar.gz

COPY docker-entrypoint.sh /entrypoint.sh

RUN chmod a+x /entrypoint.sh

VOLUME ["/home/lnd/.lnd"]

EXPOSE 9735 8080 10000

ENTRYPOINT ["/entrypoint.sh"]

CMD ["lnd"]
