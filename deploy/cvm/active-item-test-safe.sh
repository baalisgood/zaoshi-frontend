#!/usr/bin/env bash
set -euo pipefail

readonly web_image_tag="${ZAOSHI_WEB_IMAGE_TAG:-}"
readonly acceptance_image_tag="${ZAOSHI_ACCEPTANCE_IMAGE_TAG:-}"
if [[ ! "$web_image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ZAOSHI_WEB_IMAGE_TAG must be a full 40-character lowercase Git SHA." >&2
  exit 64
fi
if [[ ! "$acceptance_image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ZAOSHI_ACCEPTANCE_IMAGE_TAG must be a full 40-character lowercase Git SHA." >&2
  exit 64
fi
if [[ "$web_image_tag" != "$acceptance_image_tag" ]]; then
  echo "Web and acceptance image tags must use the same reviewed release SHA." >&2
  exit 64
fi

readonly action="${1:-}"
readonly run_id="${2:-}"
if [[ ! "$action" =~ ^(seed|run|recover|sweep|inspect|web-up|web-down)$ ]]; then
  echo "Usage: active-item-test-safe.sh seed|run|recover|sweep|inspect|web-up|web-down [run-id]" >&2
  exit 64
fi
if [[ "$action" =~ ^(seed|run|recover|sweep|inspect)$ ]] && [[ ! "$run_id" =~ ^[a-z0-9][a-z0-9-]{7,63}$ ]]; then
  echo "run-id must contain 8-64 lowercase letters, digits or hyphens." >&2
  exit 64
fi
if [[ "$action" =~ ^(seed|run|recover|sweep|inspect)$ ]] &&
   [[ ! "$run_id" =~ ^(happy-path|claim-ack-loss|output-ack-loss|spool-recovery|reconciliation)- ]]; then
  echo "run-id must start with one of the fixed acceptance scenario prefixes." >&2
  exit 64
fi
if [[ "$action" == "recover" ]] &&
   [[ ! "$run_id" =~ ^(claim-ack-loss|output-ack-loss|spool-recovery)- ]]; then
  echo "recover is only valid for a recoverable acceptance scenario." >&2
  exit 64
fi
if [[ "$action" == "sweep" ]] &&
   [[ ! "$run_id" =~ ^(claim-ack-loss|reconciliation)- ]]; then
  echo "sweep is only valid for a lease-expiry acceptance scenario." >&2
  exit 64
fi

container_running() {
  local name="$1"
  [[ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || true)" == "true" ]]
}

require_private_directory() {
  local path="$1"
  if [[ ! -d "$path" ]] || [[ -L "$path" ]] ||
     [[ "$(stat -c '%u:%g:%a' -- "$path")" != "10001:10001:700" ]]; then
    echo "Acceptance directory must be a real 10001:10001 mode 0700 directory: $path" >&2
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
    echo "Acceptance secret must be a real 10001:10001 mode 0400/0600 file: $path" >&2
    exit 73
  fi
}

if container_running zaoshi-generation-consumer; then
  echo "The provider consumer must be stopped before acceptance testing." >&2
  exit 73
fi
if [[ ! -d /var/lib/zaoshi/consumer ]] ||
   [[ -L /var/lib/zaoshi/consumer ]] ||
   [[ ! -f /var/lib/zaoshi/consumer/.consumer.lock ]] ||
   [[ -L /var/lib/zaoshi/consumer/.consumer.lock ]]; then
  echo "The shared provider-consumer lock must be a regular file." >&2
  exit 73
fi
for directory in \
  /var/lib/zaoshi/active-item-test/db \
  /var/lib/zaoshi/active-item-test/objects \
  /var/lib/zaoshi/active-item-test/spool; do
  require_private_directory "$directory"
done
require_private_secret /etc/zaoshi/active-item-test/acceptance-hmac
require_private_secret /etc/zaoshi/active-item-test/acceptance-ticket

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly compose=(docker compose --project-name zaoshi-acceptance --file "$script_dir/active-item-test.compose.yaml")

case "$action" in
  seed|inspect)
    if container_running zaoshi-acceptance-web; then
      echo "The acceptance Web service must be stopped for offline database access." >&2
      exit 73
    fi
    exec "${compose[@]}" run --rm --no-deps acceptance-admin "$action" "$run_id"
    ;;
  run|recover|sweep)
    if ! container_running zaoshi-acceptance-web; then
      echo "The acceptance Web service must be running before the probe." >&2
      exit 73
    fi
    exec "${compose[@]}" run --rm acceptance-probe "$action" "$run_id"
    ;;
  web-up)
    exec "${compose[@]}" up --detach --no-build acceptance-web
    ;;
  web-down)
    exec "${compose[@]}" stop acceptance-web
    ;;
esac
