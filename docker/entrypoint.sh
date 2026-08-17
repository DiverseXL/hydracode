#!/usr/bin/env bash
set -euo pipefail

# Fail loudly if the token wasn't provided at runtime (never baked into the
# image — it comes from HYDRADB_DEV_TOKEN in the host's .env file).
: "${HYDRADB_DEV_TOKEN:?HYDRADB_DEV_TOKEN is required — set it in .env (copy .env.example), then: docker compose up --build}"

HYDRADB_ROOT=/opt/hydradb
STORE_DIR="$HYDRADB_ROOT/.hydradb/store"
CACHE_DIR="$HYDRADB_ROOT/.hydradb/cache"
TOKEN_FILE="$HYDRADB_ROOT/.hydradb/auth-token"

mkdir -p "$STORE_DIR" "$CACHE_DIR"
printf '%s' "$HYDRADB_DEV_TOKEN" > "$TOKEN_FILE"

# HydraDB local quickstart env vars (per HydraDB's README).
export CLOUD_PROVIDER=local
export LOCAL_PATH="$STORE_DIR"
export GRAPH_NAMESPACE=default
export GRAPH_ID=default
export GRAPH_CELL_ID=cell-0
export GRAPH_CELLS=cell-0
export GRAPH_NODE_ID=node-0
# Bolt, HTTP, and Admin all default to 127.0.0.1 in HydraDB's bare-metal
# example (per HydraDB's AGENTS.md). Inside the container, 127.0.0.1 is a
# different network namespace than the host's loopback, so Docker's port
# publishing could never reach it — only the in-container healthcheck would
# work. Bind 0.0.0.0 so the host client can connect to the published ports.
export GRAPH_BOLT_NODE_ADDRESSES=node-0=0.0.0.0:7687
export GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687
export GRAPH_HTTP_ADDR=0.0.0.0:8443
export GRAPH_ADMIN_ADDR=0.0.0.0:9090
export GRAPH_DATA_CACHE_DIR="$CACHE_DIR"
export GRAPH_AUTH_TOKEN_FILE="$TOKEN_FILE"
# GRAPH_ALLOW_PLAINTEXT=true disables TLS on BOTH public adapters (Bolt and
# HTTP) per HydraDB's AGENTS.md — no separate HTTP plaintext override is
# needed, so curl to :8443 without TLS succeeds.
export GRAPH_ALLOW_PLAINTEXT=true
export RUST_MIN_STACK=33554432

exec /opt/hydradb/graph-node
