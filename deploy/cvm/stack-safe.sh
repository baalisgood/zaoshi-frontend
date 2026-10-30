#!/usr/bin/env bash
set -euo pipefail

readonly web_image_tag="${ZAOSHI_WEB_IMAGE_TAG:-}"
readonly consumer_image_tag="${ZAOSHI_CONSUMER_IMAGE_TAG:-}"
if [[ ! "$web_image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ZAOSHI_WEB_IMAGE_TAG must be a full 40-character lowercase Git SHA." >&2
  exit 64
fi
if [[ ! "$consumer_image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ZAOSHI_CONSUMER_IMAGE_TAG must be a full 40-character lowercase Git SHA." >&2
  exit 64
fi
if [[ "$web_image_tag" != "$consumer_image_tag" ]]; then
  echo "Web and consumer image tags must use the same reviewed release SHA." >&2
  exit 64
fi

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec docker compose --file "$script_dir/stack.compose.yaml" "$@"
