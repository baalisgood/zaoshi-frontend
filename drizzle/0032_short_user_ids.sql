ALTER TABLE users ADD COLUMN identity_namespace TEXT;
UPDATE users SET identity_namespace = id;
CREATE UNIQUE INDEX users_identity_namespace_unique ON users(identity_namespace);
CREATE TRIGGER users_namespace_insert AFTER INSERT ON users
WHEN NEW.identity_namespace IS NULL
BEGIN UPDATE users SET identity_namespace = NEW.id WHERE id = NEW.id; END;
CREATE TRIGGER users_namespace_immutable BEFORE UPDATE OF identity_namespace ON users
WHEN OLD.identity_namespace IS NOT NULL AND NEW.identity_namespace IS NOT OLD.identity_namespace
BEGIN SELECT RAISE(ABORT, 'identity namespace is immutable'); END;
CREATE TRIGGER users_id_format_update BEFORE UPDATE OF id ON users
WHEN NEW.id <> OLD.id AND (length(NEW.id) <> 8 OR NEW.id GLOB '*[^A-Z0-9]*' OR NEW.id NOT GLOB '*[A-Z]*' OR NEW.id NOT GLOB '*[0-9]*')
BEGIN SELECT RAISE(ABORT, 'invalid user id'); END;
ALTER TABLE assets ADD COLUMN moderation_mode TEXT CHECK(moderation_mode IN ('disabled','tencent'));
CREATE TRIGGER assets_moderation_mode_immutable BEFORE UPDATE OF moderation_mode ON assets
WHEN NEW.moderation_mode IS NOT OLD.moderation_mode
BEGIN SELECT RAISE(ABORT, 'moderation mode is immutable'); END;
CREATE TABLE user_id_migration_receipts(action_id TEXT PRIMARY KEY NOT NULL,mapping_sha256 TEXT NOT NULL,snapshot_sha256 TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TRIGGER user_id_migration_receipts_no_update BEFORE UPDATE ON user_id_migration_receipts BEGIN SELECT RAISE(ABORT,'migration receipt is immutable'); END;
CREATE TRIGGER user_id_migration_receipts_no_delete BEFORE DELETE ON user_id_migration_receipts BEGIN SELECT RAISE(ABORT,'migration receipt is preserved'); END;
