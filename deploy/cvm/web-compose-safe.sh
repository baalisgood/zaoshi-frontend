#!/usr/bin/env bash
set -euo pipefail

readonly image_tag="${ZAOSHI_WEB_IMAGE_TAG:-}"
if [[ ! "$image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ZAOSHI_WEB_IMAGE_TAG must be a full 40-character lowercase Git SHA." >&2
  exit 64
fi

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec docker compose --file "$script_dir/web.compose.yaml" "$@"
