#!/usr/bin/env bash
set -euo pipefail

readonly web_image_tag="${ZAOSHI_WEB_IMAGE_TAG:-}"
readonly canary_image_tag="${ZAOSHI_CANARY_IMAGE_TAG:-}"
if [[ ! "$web_image_tag" =~ ^[0-9a-f]{40}$ ]] ||
   [[ ! "$canary_image_tag" =~ ^[0-9a-f]{40}$ ]] ||
   [[ "$web_image_tag" != "$canary_image_tag" ]]; then
  echo "Web and provider Canary images must use the same full release SHA." >&2
  exit 64
fi

readonly action="${1:-}"
readonly confirmation="${2:-}"
if [[ ! "$action" =~ ^(seed|inspect|web-up|web-down|run|recover|verify-http)$ ]]; then
  echo "Usage: provider-canary-safe.sh seed|inspect|web-up|web-down|run|recover|verify-http" >&2
  exit 64
fi
if [[ "$action" == "run" ]] && [[ "$confirmation" != "--confirm-cost=ONE_SEEDREAM_45_IMAGE" ]]; then
  echo "The exact one-image cost confirmation is required." >&2
  exit 64
fi
if [[ "$action" != "run" ]] && [[ -n "$confirmation" ]]; then
  echo "Unexpected argument." >&2
  exit 64
fi

container_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" == "true" ]]
}

require_private_directory() {
  local path="$1"
  if [[ ! -d "$path" ]] || [[ -L "$path" ]] ||
     [[ "$(stat -c '%u:%g:%a' -- "$path")" != "10001:10001:700" ]]; then
    echo "Provider Canary directory must be a real 10001:10001 mode 0700 directory: $path" >&2
    exit 73
  fi
}

require_private_secret() {
  local path="$1"
  local metadata=""
  if [[ -f "$path" ]] && [[ ! -L "$path" ]]; then
    metadata="$(stat -c '%u:%g:%a' -- "$path")"
  fi
  if [[ "$metadata" != "10001:10001:400" ]] &&
     [[ "$metadata" != "10001:10001:600" ]]; then
    echo "Provider Canary secret must be a real 10001:10001 mode 0400/0600 file: $path" >&2
    exit 73
  fi
}

if container_running zaoshi-generation-consumer; then
  echo "The normal provider consumer must be stopped." >&2
  exit 73
fi
if [[ ! -f /var/lib/zaoshi/consumer/.consumer.lock ]] ||
   [[ -L /var/lib/zaoshi/consumer/.consumer.lock ]]; then
  echo "The shared provider-consumer lock must be a regular file." >&2
  exit 73
fi
for directory in \
  /var/lib/zaoshi/provider-canary/db \
  /var/lib/zaoshi/provider-canary/objects \
  /var/lib/zaoshi/provider-canary/spool; do
  require_private_directory "$directory"
done
require_private_secret /etc/zaoshi/provider-canary/provider-canary-hmac
require_private_secret /etc/zaoshi/provider-canary/provider-canary-ticket
if [[ "$action" == "run" ]]; then
  require_private_secret /etc/zaoshi/provider-canary/seedream-api-key
fi

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly compose=(docker compose --project-name zaoshi-provider-canary --file "$script_dir/provider-canary.compose.yaml")

case "$action" in
  seed|inspect)
    if container_running zaoshi-provider-canary-web; then
      echo "The provider Canary Web must be stopped for offline access." >&2
      exit 73
    fi
    exec "${compose[@]}" run --rm --no-deps canary-admin "$action"
    ;;
  web-up)
    exec "${compose[@]}" up --detach --no-build canary-web
    ;;
  web-down)
    exec "${compose[@]}" stop canary-web
    ;;
  run)
    if ! container_running zaoshi-provider-canary-web; then
      echo "The provider Canary Web must be running." >&2
      exit 73
    fi
    exec "${compose[@]}" run --rm canary-runner run "$confirmation"
    ;;
  recover)
    if ! container_running zaoshi-provider-canary-web; then
      echo "The provider Canary Web must be running." >&2
      exit 73
    fi
    exec "${compose[@]}" run --rm canary-recover recover
    ;;
  verify-http)
    if ! container_running zaoshi-provider-canary-web; then
      echo "The provider Canary Web must be running." >&2
      exit 73
    fi
    exec "${compose[@]}" run --rm canary-probe verify-http
    ;;
esac
