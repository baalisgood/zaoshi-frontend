#!/usr/bin/env bash
set -euo pipefail

readonly action="${1:-}"
if [[ ! "$action" =~ ^(config|web-up|web-down|consumer-up|consumer-down|status)$ ]]; then
  echo "Usage: private-test-safe.sh config|web-up|web-down|consumer-up|consumer-down|status" >&2
  exit 64
fi

# Stop/status must keep working after the 24-hour test window or a secret expires.
if [[ "$action" == "status" ]]; then
  exec docker ps --all --filter label=com.docker.compose.project=zaoshi-web-private-test --format '{{.Names}} {{.Status}} {{.Ports}}'
fi
if [[ "$action" == "web-down" || "$action" == "consumer-down" ]]; then
  if [[ "$action" == "web-down" ]]; then target=zaoshi-web-private-test; else target=zaoshi-generation-consumer-private-test; fi
  if [[ "$action" == "web-down" ]] && [[ "$(docker inspect --format '{{.State.Running}}' zaoshi-generation-consumer-private-test 2>/dev/null || true)" == "true" ]]; then
    echo "Stop the private-test consumer before stopping its Web control plane." >&2
    exit 73
  fi
  project="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$target")"
  if [[ "$project" != "zaoshi-web-private-test" ]]; then echo "Refusing to stop a container outside the private-test project." >&2; exit 73; fi
  if [[ "$action" == "consumer-down" ]]; then exec docker stop --timeout 900 "$target"; fi
  exec docker stop --timeout 30 "$target"
fi

readonly web_image_tag="${ZAOSHI_WEB_IMAGE_TAG:-}"
readonly consumer_image_tag="${ZAOSHI_CONSUMER_IMAGE_TAG:-}"
if [[ ! "$web_image_tag" =~ ^[0-9a-f]{40}$ ]] || [[ "$web_image_tag" != "$consumer_image_tag" ]]; then
  echo "Web and consumer images must use the same full lowercase release SHA." >&2
  exit 64
fi
readonly expiry="${PRIVATE_TEST_EXPIRES_AT:-}"
readonly now="$(date +%s)"
if [[ ! "$expiry" =~ ^[0-9]{10}$ ]] || (( expiry <= now || expiry > now + 86400 )); then
  echo "PRIVATE_TEST_EXPIRES_AT must be within the next 24 hours." >&2
  exit 64
fi
if [[ ! "${ZAOSHI_QWEN_WORKSPACE_ID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$ ]]; then
  echo "ZAOSHI_QWEN_WORKSPACE_ID is invalid." >&2
  exit 64
fi

require_directory() {
  local path="$1"
  if [[ ! -d "$path" ]] || [[ -L "$path" ]] || [[ "$(stat -c '%u:%g:%a' -- "$path")" != "10001:10001:700" ]]; then
    echo "Private-test directory must be a real 10001:10001 mode 0700 directory: $path" >&2
    exit 73
  fi
}
require_secret() {
  local path="$1" metadata=""
  [[ -f "$path" ]] && [[ ! -L "$path" ]] && metadata="$(stat -c '%u:%g:%a' -- "$path")"
  if [[ "$metadata" != "10001:10001:400" ]] && [[ "$metadata" != "10001:10001:600" ]]; then
    echo "Private-test secret must be a real 10001:10001 mode 0400/0600 file: $path" >&2
    exit 73
  fi
}
container_running() { [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" == "true" ]]; }

for path in /var /var/lib /var/lib/zaoshi /var/lib/zaoshi/web-private-test /var/lib/zaoshi/consumer /etc /etc/zaoshi /etc/zaoshi/private-test; do
  if [[ ! -d "$path" ]] || [[ -L "$path" ]]; then echo "Private-test ancestor must be a real directory: $path" >&2; exit 73; fi
done
for path in db objects spool health; do require_directory "/var/lib/zaoshi/web-private-test/$path"; done
if [[ ! -f /var/lib/zaoshi/consumer/.consumer.lock ]] || [[ -L /var/lib/zaoshi/consumer/.consumer.lock ]]; then
  echo "The shared provider-consumer lock must be a regular file." >&2
  exit 73
fi
for name in consumer-hmac queue-ticket; do require_secret "/etc/zaoshi/private-test/$name"; done
readonly overseas="${ZAOSHI_PRIVATE_TEST_OVERSEAS_ENABLED:-0}"
if [[ "$overseas" != "0" && "$overseas" != "1" ]]; then echo "ZAOSHI_PRIVATE_TEST_OVERSEAS_ENABLED must be 0 or 1." >&2; exit 64; fi
if [[ "$overseas" == "1" ]]; then
  require_directory /var/lib/zaoshi/overseas-sockets
  path="/var/lib/zaoshi/overseas-sockets/sub2api.sock"
  if [[ ! -S "$path" || -L "$path" || "$(stat -c '%u:%g:%a' -- "$path")" != "10001:10001:600" ]]; then echo "Overseas socket must be real 10001:10001 mode 0600: $path" >&2; exit 73; fi
  for name in openai google; do
    require_secret "/etc/zaoshi/private-test/$name-gateway-key"
  done
fi
if [[ "$action" == "consumer-up" ]]; then
  if container_running zaoshi-generation-consumer; then echo "The normal provider consumer must be stopped." >&2; exit 73; fi
  require_secret /etc/zaoshi/private-test/seedream-api-key
  require_secret /etc/zaoshi/private-test/qwen-api-key
fi

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose --project-name zaoshi-web-private-test --file "$script_dir/private-test.compose.yaml")
if [[ "$overseas" == "1" ]]; then compose+=(--file "$script_dir/private-test-overseas.compose.yaml"); fi
readonly compose
case "$action" in
  config) exec "${compose[@]}" config --quiet ;;
  web-up) exec "${compose[@]}" up --detach --no-build private-test-web ;;
  consumer-up) exec "${compose[@]}" up --detach --no-build private-test-consumer ;;
esac
