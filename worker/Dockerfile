FROM rust:1.99-slim AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY schemas ./schemas
COPY modules ./modules
COPY scripts ./scripts
COPY docs ./docs
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo build --locked --release -p rio-runner && cp target/release/rio-runner /build/rio-runner

FROM rust:1.99-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 nodejs ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home rio
COPY --from=build /build/rio-runner /usr/local/bin/rio-runner
COPY worker/runner/execute.py /opt/rio/execute.py
ENV RIO_CONTAINER=1
USER 10001:10001
WORKDIR /tmp
CMD ["/bin/sleep", "180"]
