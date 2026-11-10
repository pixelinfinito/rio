FROM rust:1.99-slim AS build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libdbus-1-dev && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY schemas ./schemas
COPY modules ./modules
COPY scripts ./scripts
COPY docs ./docs
COPY worker/bundle ./worker/bundle
COPY worker/qa ./worker/qa
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/target cargo build --locked --release -p rio-runner -p rio-cli && cp target/release/rio-runner target/release/rio /build/

FROM rust:1.99-slim
COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/
# Toolchains for hosted checks (PR mode): TypeScript, Python and Rust. Checks
# still follow the dependency compatibility rules: a project whose dependencies
# are not vendored or installed in the snapshot is skipped with the reason.
# git is used only by the clone phase of a prepare job.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv nodejs npm git ca-certificates libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund typescript@5.9.3 eslint@9.39.1 \
    && npm cache clean --force \
    && python3 -m venv /opt/rio/python \
    && /opt/rio/python/bin/pip install --no-cache-dir mypy==1.18.2 ruff==0.14.4 pytest==8.4.2 coverage==7.11.3 \
    && ln -s /opt/rio/python/bin/mypy /opt/rio/python/bin/ruff /opt/rio/python/bin/pytest /opt/rio/python/bin/coverage /usr/local/bin/ \
    && (rustup component list --installed | grep -q '^clippy' || rustup component add clippy) \
    && useradd --uid 10001 --create-home rio
COPY --from=build /build/rio-runner /usr/local/bin/rio-runner
COPY --from=build /build/rio /usr/local/bin/rio
COPY worker/runner/execute.py /opt/rio/execute.py
# QA is provisioned at deployment, never from repository Dockerfiles at run time.
# Only QA's own node copy may bind low app ports: the runner's checks drop every
# capability, and a binary with file capabilities then cannot execute.
WORKDIR /opt/rio-qa
COPY crates/rio-qa/controller/package.json crates/rio-qa/controller/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm install --global --no-audit --no-fund @openai/codex@0.167.0 @mariozechner/pi-coding-agent@0.73.1 \
    && npx playwright install --with-deps chromium \
    && mv /root/.cache/ms-playwright /opt/rio-browsers \
    && chmod -R a+rX /opt/rio-browsers \
    && apt-get install -y --no-install-recommends sqlite3 postgresql-client default-mysql-client redis-tools openssl libcap2-bin \
    && mkdir -p /opt/rio-qa/bin && cp /usr/local/bin/node /opt/rio-qa/bin/node \
    && setcap cap_net_bind_service=+ep /opt/rio-qa/bin/node \
    && useradd --uid 1000 --create-home node \
    && rm -rf /var/lib/apt/lists/* && npm cache clean --force
COPY crates/rio-qa/controller/src ./src
COPY modules/qa/skill ./skill
COPY modules/qa/rules ./rules
COPY schemas/qa-*.json schemas/journey-v1.json schemas/report-v1.json ./schemas/
COPY worker/qa/sandbox.py worker/qa/pod.py ./
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/rio-browsers
ENV RIO_CONTAINER=1
USER 10001:10001
WORKDIR /tmp
CMD ["/bin/sleep", "180"]
