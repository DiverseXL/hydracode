#!/usr/bin/env bash
set -euo pipefail

# Build the hydradb dev image and push it to GHCR.
#
# Purely additive: builds the exact same image docker-compose.yml builds,
# then tags and pushes it. No source changes are made.
#
# Uses `docker buildx build --push` rather than `docker build` + `docker push`
# because the latter hangs on the manifest PUT for large images when Docker
# Desktop uses the containerd image store (io.containerd.snapshotter.v1).
# BuildKit's own push path is unaffected, so this works everywhere.
#
# Prereqs:
#   - docker with BuildKit (default)
#   - authenticated against GHCR:
#       docker login ghcr.io --username <your-github-username>
#     (password = a PAT with the `write:packages` scope)
#
# Usage:
#   scripts/publish-docker.sh            # build + tag locally, no push
#   scripts/publish-docker.sh --push     # build, tag, and push
#
# The image name defaults to this repo's GHCR package. Override with IMAGE:
#   IMAGE=docker.io/<you>/hydradb scripts/publish-docker.sh --push

IMAGE="${IMAGE:-ghcr.io/diversexl/hydracode/hydradb}"

VERSION="$(node -p "require('./package.json').version")"
SHA="$(git rev-parse --short HEAD)"

TAGS=(
  "$IMAGE:latest"
  "$IMAGE:$VERSION"
  "$IMAGE:sha-$SHA"
)

echo "==> Building $IMAGE (version=$VERSION, sha=$SHA)"
for tag in "${TAGS[@]}"; do
  echo "    $tag"
done

if [[ "${1:-}" == "--push" ]]; then
  echo "==> Building + pushing"
  docker buildx build --push \
    -t "${TAGS[0]}" \
    -t "${TAGS[1]}" \
    -t "${TAGS[2]}" \
    -f docker/hydradb.Dockerfile \
    ./docker
  echo "==> Done. Prebuilt image is live at ${TAGS[0]}"
else
  echo "==> Building (no push)"
  docker buildx build \
    -t "${TAGS[0]}" \
    -t "${TAGS[1]}" \
    -t "${TAGS[2]}" \
    -f docker/hydradb.Dockerfile \
    ./docker
  echo "==> Built and tagged locally (no push). Re-run with --push to publish."
fi
