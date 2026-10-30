#!/usr/bin/env bash
set -euo pipefail

readonly image_tag="${ZAOSHI_BACKUP_IMAGE_TAG:-}"
if [[ ! "$image_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ZAOSHI_BACKUP_IMAGE_TAG must be the full lowercase Git SHA of the installed Web image." >&2
  exit 64
fi
if [[ "$EUID" -ne 0 ]]; then
  echo "Run backup-safe.sh as root." >&2
  exit 77
fi

readonly database_dir="/var/lib/zaoshi/db"
readonly object_dir="/var/lib/zaoshi/objects"
readonly consumer_dir="/var/lib/zaoshi/consumer"
readonly backup_root="/var/backups/zaoshi"
readonly database_file="$database_dir/zaoshi.sqlite"
readonly web_lock="$database_dir/.web.lock"
readonly consumer_lock="$consumer_dir/.consumer.lock"
readonly image="zaoshi-web:$image_tag"

container_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" == "true" ]]
}

if container_running zaoshi-web || container_running zaoshi-generation-consumer; then
  echo "Stop the Web and consumer before creating an offline backup." >&2
  exit 69
fi
readonly installed_web_image="$(docker inspect --format '{{.Config.Image}}' zaoshi-web 2>/dev/null || true)"
if [[ "$installed_web_image" != "$image" ]]; then
  echo "ZAOSHI_BACKUP_IMAGE_TAG does not match the installed Web container." >&2
  exit 66
fi
readonly installed_web_image_id="$(docker inspect --format '{{.Image}}' zaoshi-web 2>/dev/null || true)"
readonly tagged_web_image_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)"
if [[ -z "$installed_web_image_id" || "$installed_web_image_id" != "$tagged_web_image_id" ]]; then
  echo "The installed Web container image ID no longer matches its release tag." >&2
  exit 66
fi
if [[ ! -d "$consumer_dir" || -L "$consumer_dir" ||
      "$(stat -c '%u:%g:%a' "$consumer_dir")" != "10001:10001:700" ]]; then
  echo "The consumer directory must be a real private directory owned by 10001:10001." >&2
  exit 65
fi
if [[ -L "$consumer_lock" ]]; then
  echo "The consumer lock must not be a symbolic link." >&2
  exit 65
fi
if [[ ! -e "$consumer_lock" ]]; then
  if ! (set -o noclobber; : > "$consumer_lock") 2>/dev/null; then
    echo "Could not safely create the consumer lock." >&2
    exit 73
  fi
  chown --no-dereference 10001:10001 "$consumer_lock"
  chmod 0600 "$consumer_lock"
fi
if [[ ! -f "$consumer_lock" || -L "$consumer_lock" ||
      "$(stat -c '%u:%g:%h' "$consumer_lock")" != "10001:10001:1" ]]; then
  echo "The consumer lock must be a private regular file owned by 10001:10001." >&2
  exit 65
fi
chmod 0600 "$consumer_lock"
if [[ ! -d "$database_dir" || -L "$database_dir" ||
      ! -d "$object_dir" || -L "$object_dir" ||
      ! -d "$consumer_dir" || -L "$consumer_dir" ||
      ! -f "$database_file" || -L "$database_file" ||
      ! -f "$web_lock" || -L "$web_lock" ||
      ! -f "$consumer_lock" || -L "$consumer_lock" ]]; then
  echo "Database and object paths must be real directories with a regular SQLite file." >&2
  exit 65
fi
if [[ "$(stat -c '%u:%g:%h' "$web_lock")" != "10001:10001:1" ]]; then
  echo "The Web lock must be a private regular file owned by 10001:10001." >&2
  exit 65
fi
chmod 0600 "$web_lock"
if find "$database_dir" "$object_dir" -xdev -type l -print -quit | grep -q .; then
  echo "Backup sources must not contain symbolic links." >&2
  exit 65
fi
exec 9<>"$web_lock"
if ! flock --nonblock 9; then
  echo "The Web database lock is still held." >&2
  exit 69
fi
exec 8<>"$consumer_lock"
if ! flock --nonblock 8; then
  echo "The consumer lock is still held." >&2
  exit 69
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "The installed Web image is unavailable for backup verification." >&2
  exit 66
fi
if [[ -L "$backup_root" ]]; then
  echo "The backup root must not be a symbolic link." >&2
  exit 65
fi

readonly timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup_dir="$backup_root/${timestamp}-pre-${image_tag}"
if [[ -e "$backup_dir" || -L "$backup_dir" ]]; then
  echo "The backup destination already exists." >&2
  exit 73
fi

install -d -m 0700 -o root -g root "$backup_root"
install -d -m 0700 -o root -g root "$backup_dir"
cp -a --reflink=auto "$database_dir" "$backup_dir/db"
cp -a --reflink=auto "$object_dir" "$backup_dir/objects"
sync "$backup_dir"

docker run --rm --network none --read-only --user 10001:10001 \
  --entrypoint node \
  --mount "type=bind,src=$backup_dir/db,dst=/backup/db" \
  "$tagged_web_image_id" -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync("/backup/db/zaoshi.sqlite", { readOnly: true });
    db.exec("PRAGMA query_only=ON");
    const integrity = db.prepare("PRAGMA integrity_check").all();
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || foreignKeys.length !== 0) {
      process.exit(1);
    }
  '

(
  cd "$backup_dir"
  find db objects -xdev -type f -print0 | sort -z | xargs -0 sha256sum > manifest.sha256
)
chmod 0600 "$backup_dir/manifest.sha256"
echo "$backup_dir"
