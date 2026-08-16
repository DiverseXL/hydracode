# hydradb dev image for hydracode.
#
# Builds graph-node from source (native Rust build with libcypher-parser and
# SuiteSparse GraphBLAS, per HydraDB's docs) and BAKES the compiled release
# binary into the image layer, so container restarts don't rebuild from
# scratch. The auth token and runtime env vars are NOT baked in — they are
# passed at `docker compose up` time via .env and applied by entrypoint.sh.
#
# Two stages:
#   - audit: clones the source and greps the real bind-address config, so we
#     can confirm HTTP/Admin ports and bind addrs from source WITHOUT the
#     expensive release compile. Build just this stage with:
#       docker build --target audit -t hydracode-audit ./docker
#       docker run --rm hydracode-audit cat /opt/hydradb/BIND_ADDR_AUDIT.txt
#   - build (final, default target): the full image. It reuses the audit
#     stage's clone (COPY --from) so the repo is cloned once, not twice, and
#     the cargo build step is unchanged and unreordered.

# ------------------------------ stage: audit ------------------------------
FROM ubuntu:24.04 AS audit

# Only git + ca-certificates are needed to clone + audit — keeps this stage
# fast. ca-certificates is required or git clone fails TLS verification
# (CAfile: none) in a fresh Ubuntu container.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/hydra-db/hydradb.git /opt/hydradb

# Audit the real bind-address config across the whole src/ tree (HTTP/Admin
# ports, bind addresses, GRAPH_*_ADDR env keys, listen directives) — config
# lives in src/bin/graph_node/config.rs as well as src/core and src/client.
# Dots are escaped so 0.0.0.0 matches literal bind addrs, not numeric
# literals like 10_000_000. `|| true` so an empty match never fails the
# stage; the artifact is also copied into the final image via COPY --from.
RUN grep -rn --exclude-dir=target "8443\|9090\|0\.0\.0\.0\|GRAPH_.*ADDR\|listen" /opt/hydradb/src 2>/dev/null | tee /opt/hydradb/BIND_ADDR_AUDIT.txt || true

# ------------------------------ stage: build ------------------------------
FROM ubuntu:24.04

# Native dependencies per HydraDB's docs (libcypher-parser + SuiteSparse
# GraphBLAS, plus the toolchain needed to build Rust bindings for them).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    clang \
    libclang-dev \
    cmake \
    pkg-config \
    libcypher-parser-dev \
    libgraphblas-dev \
    curl \
    git \
    python3 \
    python3-venv \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Rust (stable) via the official rustup script; minimal profile is enough
# for a plain cargo build.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable

ENV PATH="/root/.cargo/bin:${PATH}" \
    CARGO_HOME=/root/.cargo

# Reuse the audit stage's clone (includes BIND_ADDR_AUDIT.txt).
COPY --from=audit /opt/hydradb /opt/hydradb

# Clone and build the server binary into the image layer.
#
# Cache mounts (registry/git/target) keep the Rust compile resumable: if the
# build is interrupted (CI timeouts, laptop sleep), the next build picks up
# the incremental cargo state instead of recompiling from zero. Trade-off:
# RUN steps with cache mounts always re-execute, but cargo short-circuits on
# up-to-date artifacts.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/opt/hydradb/target \
    cd /opt/hydradb \
  && cargo build --locked --release --features server-runtime --bin graph-node

WORKDIR /opt/hydradb

# Entrypoint (copied from this build context, docker/). Normalize line
# endings — files checked out on Windows can carry CRLF, which breaks bash —
# and mark executable.
COPY entrypoint.sh /opt/hydradb/entrypoint.sh
RUN sed -i 's/\r$//' /opt/hydradb/entrypoint.sh && chmod +x /opt/hydradb/entrypoint.sh

EXPOSE 8443 7687 9090
