# hydracode

A developer tool that indexes a codebase into a **HydraDB** graph and lets AI
coding agents query it for multi-hop, relationship-aware context — function
calls, imports, tests, and configuration — plus a temporal memory layer for
tracking decisions over time.

## What it does

- **index** — walks the codebase (TypeScript/JavaScript, more later) and builds
  a graph in HydraDB: files, symbols, call edges, import edges, test relations,
  and config references.
- **ask** — natural-language / structured queries against the graph for
  multi-hop context (e.g. "what calls `foo`, and which tests cover those
  callers?").
- **memory** — a temporal layer that records decisions and their rationale so
  agents can recall and reason about them later.
- **mcp** — an MCP (Model Context Protocol) server exposing the graph and
  memory to AI coding agents.
- **status** — reports connectivity to a running HydraDB instance.

## Prerequisites

- **Node.js 20+**
- **HydraDB** running locally via its native Rust build —
  see <https://github.com/hydra-db/hydradb>.
  - Rust **1.91+**
  - `libcypher-parser`
  - SuiteSparse **GraphBLAS**
  - On Windows, run HydraDB via **WSL** (Windows Subsystem for Linux).

## Getting Started

_Placeholder — commands to be filled in once indexing and querying are
implemented._

```bash
npm install
npm run build

# e.g.
# npx hydracode index --path ./src
# npx hydracode ask "Which tests cover the callers of createClient?"
# npx hydracode status
```

## Running HydraDB locally (Docker)

The repo ships a Docker-based dev environment for HydraDB (native Rust build
with libcypher-parser + SuiteSparse GraphBLAS, per the prerequisites above).
It builds the `graph-node` binary into the image so restarts don't rebuild,
and takes the auth token from your host's `.env` at runtime.

```bash
# 1. Create the env file (dev token only — never use outside local dev)
cp .env.example .env

# 2. Build and start (first build takes 10-30+ minutes: Rust release build)
docker compose up --build

# 3. From the host, confirm it's ready
curl http://127.0.0.1:8443/healthz
```

Then point hydracode at it:

```bash
export HYDRACODE_HYDRADB_URI=http://127.0.0.1:8443
export HYDRACODE_HYDRADB_TOKEN=local-development-token-32-bytes
export HYDRACODE_HYDRADB_ALLOW_PLAINTEXT=true

npm run smoke            # healthCheck + a trivial RETURN 1 AS one query
npx tsx scripts/index-self.ts   # index this repo's src/ and write the graph
```

Ports: **8443** HTTP query API, **7687** Bolt, **9090** admin. Graph data
persists in the `hydradb-store` named volume. To stop: `docker compose down`.

### Prebuilt image (skip the Rust build)

A prebuilt image is published to GHCR
(`ghcr.io/diversexl/hydracode/hydradb`) so you can skip the 10-30+ minute
build entirely:

```bash
cp .env.example .env

docker compose -f docker-compose.yml -f docker-compose.published.yml pull
docker compose -f docker-compose.yml -f docker-compose.published.yml up
```

The published image is exactly what `docker compose up --build` produces —
same Dockerfile, same baked `graph-node` binary — and it is refreshed on
every push to `main` and on `v*` tags (see `.github/workflows/publish-docker.yml`).

#### Publishing the image (maintainers)

The image is published automatically by CI. To publish manually (e.g. before
setting up CI, or from a local machine):

```bash
# one-time: authenticate against GHCR (password = PAT with write:packages)
docker login ghcr.io --username <your-github-username>

# build + tag locally (no push)
scripts/publish-docker.sh

# build, tag, and push latest/<version>/sha-<sha>
scripts/publish-docker.sh --push
```

## Development

```bash
npm run dev    # run the CLI from source with tsx
npm run build  # compile to dist/
npm start      # run the compiled CLI
```

## License

AGPL-3.0-or-later — matching HydraDB's own license, required since HydraDB is
a core dependency of this project.
