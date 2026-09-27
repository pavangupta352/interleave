# PostgreSQL's isolation tester, built from the PostgreSQL release that matches
# the server under test. The official server images do not include it.
#
#   docker build -t interleave-isolationtester:16.15 \
#     --build-arg BASE_IMAGE=postgres:16 \
#     --build-arg PG_VERSION=16.15 \
#     --build-arg PG_SHA256=c1575341fa7bd40f5274ea465b34390f4dc64cdd0770af327005caaeb9f6b7ed \
#     examples/historical/isolation
ARG BASE_IMAGE=postgres:16

FROM ${BASE_IMAGE} AS build
ARG PG_VERSION
ARG PG_SHA256
RUN test -n "$PG_VERSION" && test -n "$PG_SHA256" \
 && apt-get update \
 && apt-get install -y --no-install-recommends bison build-essential ca-certificates curl flex perl bzip2 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLO "https://ftp.postgresql.org/pub/source/v${PG_VERSION}/postgresql-${PG_VERSION}.tar.bz2" \
 && echo "${PG_SHA256}  postgresql-${PG_VERSION}.tar.bz2" | sha256sum -c - \
 && tar -xjf "postgresql-${PG_VERSION}.tar.bz2"
WORKDIR /src/postgresql-${PG_VERSION}
RUN ./configure --without-icu --without-readline --without-zlib > /src/configure.out \
 && make -C src/test/isolation -j"$(nproc)" isolationtester \
 && mkdir -p /opt/isolation/bin /opt/isolation/lib \
 && cp src/test/isolation/isolationtester /opt/isolation/bin/ \
 && cp -L src/interfaces/libpq/libpq.so.5 /opt/isolation/lib/ \
 && echo "${PG_VERSION}" > /opt/isolation/PG_VERSION

FROM ${BASE_IMAGE}
COPY --from=build /opt/isolation /opt/isolation
ENV LD_LIBRARY_PATH=/opt/isolation/lib PATH=/opt/isolation/bin:$PATH
ENTRYPOINT ["isolationtester"]
