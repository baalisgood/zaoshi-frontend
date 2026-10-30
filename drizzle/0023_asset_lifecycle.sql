ALTER TABLE `assets` ADD COLUMN `retention_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `deletion_requested_at` integer;
--> statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `deletion_action_id` text;
--> statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `purged_at` integer;
--> statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `moderation_status` text DEFAULT 'UNREVIEWED' NOT NULL;
--> statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `moderated_at` integer;
--> statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `moderation_reason` text;
--> statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `moderation_action_id` text;
--> statement-breakpoint
ALTER TABLE `gallery_items` ADD COLUMN `retention_expires_at` integer;
--> statement-breakpoint
UPDATE `assets` SET `retention_expires_at` = MAX(COALESCE(unixepoch(`created_at`), unixepoch()) + CASE WHEN `kind` = 'output' THEN 7776000 ELSE 2592000 END, unixepoch() + 604800) WHERE `status` = 'READY' AND `retention_expires_at` IS NULL;
--> statement-breakpoint
UPDATE `gallery_items` SET `status` = 'PENDING', `published_at` = NULL, `reviewed_at` = NULL, `reviewer_owner_id` = NULL, `review_note` = NULL WHERE `status` = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM `assets` WHERE `assets`.`id` = `gallery_items`.`source_asset_id` AND `assets`.`owner_id` = `gallery_items`.`owner_id` AND `assets`.`status` = 'READY' AND `assets`.`moderation_status` = 'APPROVED');
--> statement-breakpoint
UPDATE `gallery_items` SET `retention_expires_at` = MAX(COALESCE(unixepoch(`submitted_at`), unixepoch()) + CASE WHEN `status` = 'APPROVED' THEN 31536000 ELSE 604800 END, unixepoch() + 604800) WHERE `status` IN ('PENDING','APPROVED') AND `retention_expires_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_assets_moderation_created` ON `assets` (`moderation_status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_assets_retention` ON `assets` (`status`,`retention_expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_gallery_retention` ON `gallery_items` (`status`,`retention_expires_at`);
--> statement-breakpoint
CREATE TABLE `object_cleanup_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL CHECK (`source_type` IN ('ASSET','GALLERY')),
	`source_id` text NOT NULL,
	`object_key` text NOT NULL UNIQUE,
	`status` text DEFAULT 'PENDING' NOT NULL CHECK (`status` IN ('PENDING','RETRY','BLOCKED','SUCCEEDED')),
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_error_code` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_object_cleanup_due` ON `object_cleanup_tasks` (`status`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE TABLE `asset_maintenance_events` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL UNIQUE,
	`actor_id` text NOT NULL,
	`action` text NOT NULL CHECK (`action` = 'RETRY_BLOCKED_CLEANUP'),
	`detail_hash` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_asset_maintenance_created` ON `asset_maintenance_events` (`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `asset_maintenance_events_no_update`
BEFORE UPDATE ON `asset_maintenance_events`
BEGIN SELECT RAISE(ABORT, 'asset maintenance events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `asset_maintenance_events_no_delete`
BEFORE DELETE ON `asset_maintenance_events`
BEGIN SELECT RAISE(ABORT, 'asset maintenance events are append-only'); END;
--> statement-breakpoint
INSERT OR IGNORE INTO `object_cleanup_tasks` (`id`,`source_type`,`source_id`,`object_key`)
SELECT 'cleanup_asset_' || `id`, 'ASSET', `id`, `storage_key` FROM `assets` WHERE `status` = 'DELETED';
--> statement-breakpoint
INSERT OR IGNORE INTO `object_cleanup_tasks` (`id`,`source_type`,`source_id`,`object_key`)
SELECT 'cleanup_gallery_thumb_' || `id`, 'GALLERY', `id`, `thumb_key` FROM `gallery_items` WHERE `status` IN ('REJECTED','REVOKED');
--> statement-breakpoint
INSERT OR IGNORE INTO `object_cleanup_tasks` (`id`,`source_type`,`source_id`,`object_key`)
SELECT 'cleanup_gallery_display_' || `id`, 'GALLERY', `id`, `display_key` FROM `gallery_items` WHERE `status` IN ('REJECTED','REVOKED');
--> statement-breakpoint
CREATE TABLE `asset_moderation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL UNIQUE,
	`asset_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`decision` text NOT NULL CHECK (`decision` IN ('APPROVED','REJECTED')),
	`reason_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_asset_moderation_asset` ON `asset_moderation_events` (`asset_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `asset_moderation_events_no_update`
BEFORE UPDATE ON `asset_moderation_events`
BEGIN SELECT RAISE(ABORT, 'asset moderation events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `asset_moderation_events_no_delete`
BEFORE DELETE ON `asset_moderation_events`
BEGIN SELECT RAISE(ABORT, 'asset moderation events are append-only'); END;
--> statement-breakpoint
CREATE TABLE `asset_deletion_events` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL UNIQUE,
	`asset_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`source` text NOT NULL CHECK (`source` IN ('USER_REQUEST','MODERATION_REJECT','RETENTION_EXPIRY')),
	`detail_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_asset_deletion_asset` ON `asset_deletion_events` (`asset_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `asset_deletion_events_no_update`
BEFORE UPDATE ON `asset_deletion_events`
BEGIN SELECT RAISE(ABORT, 'asset deletion events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `asset_deletion_events_no_delete`
BEFORE DELETE ON `asset_deletion_events`
BEGIN SELECT RAISE(ABORT, 'asset deletion events are append-only'); END;
--> statement-breakpoint
CREATE TABLE `gallery_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL UNIQUE,
	`gallery_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`detail_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`gallery_id`) REFERENCES `gallery_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_gallery_audit_gallery` ON `gallery_audit_events` (`gallery_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `gallery_audit_events_no_update`
BEFORE UPDATE ON `gallery_audit_events`
BEGIN SELECT RAISE(ABORT, 'gallery audit events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `gallery_audit_events_no_delete`
BEFORE DELETE ON `gallery_audit_events`
BEGIN SELECT RAISE(ABORT, 'gallery audit events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `assets_no_undelete`
BEFORE UPDATE OF `status` ON `assets`
WHEN OLD.`status` = 'DELETED' AND NEW.`status` <> 'DELETED'
BEGIN SELECT RAISE(ABORT, 'deleted assets cannot be restored'); END;
--> statement-breakpoint
CREATE TRIGGER `assets_moderation_status_guard_insert`
BEFORE INSERT ON `assets`
WHEN NEW.`moderation_status` NOT IN ('UNREVIEWED','PENDING','APPROVED','REJECTED')
BEGIN SELECT RAISE(ABORT, 'invalid asset moderation status'); END;
--> statement-breakpoint
CREATE TRIGGER `assets_moderation_status_guard_update`
BEFORE UPDATE OF `moderation_status` ON `assets`
WHEN NEW.`moderation_status` NOT IN ('UNREVIEWED','PENDING','APPROVED','REJECTED')
BEGIN SELECT RAISE(ABORT, 'invalid asset moderation status'); END;
--> statement-breakpoint
CREATE TRIGGER `assets_delete_blocks_active_generation`
BEFORE UPDATE OF `status` ON `assets`
WHEN NEW.`status` = 'DELETED' AND OLD.`status` <> 'DELETED' AND EXISTS (
	SELECT 1 FROM `generation_jobs` AS job
	WHERE (
		job.`source_asset_id` = OLD.`id` OR job.`reference_asset_id` = OLD.`id` OR
		job.`mask_asset_id` = OLD.`id` OR job.`depth_asset_id` = OLD.`id` OR
		job.`normal_asset_id` = OLD.`id` OR EXISTS (
			SELECT 1 FROM json_each(job.`additional_references_json`)
			WHERE json_extract(json_each.value, '$.assetId') = OLD.`id`
		)
	  ) AND (
		EXISTS (SELECT 1 FROM `generation_job_items` AS item WHERE item.`job_id` = job.`id` AND item.`status` NOT IN ('SUCCEEDED', 'FAILED', 'CANCELED')) OR
		(NOT EXISTS (SELECT 1 FROM `generation_job_items` AS item WHERE item.`job_id` = job.`id`) AND job.`status` NOT IN ('SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELED'))
	  )
)
BEGIN SELECT RAISE(ABORT, 'asset is used by an active generation'); END;
--> statement-breakpoint
CREATE TRIGGER `gallery_source_must_be_ready`
BEFORE INSERT ON `gallery_items`
WHEN NOT EXISTS (SELECT 1 FROM `assets` WHERE `id` = NEW.`source_asset_id` AND `owner_id` = NEW.`owner_id` AND `status` = 'READY' AND `moderation_status` = 'APPROVED')
BEGIN SELECT RAISE(ABORT, 'gallery source must be an approved ready owned asset'); END;
--> statement-breakpoint
CREATE TRIGGER `gallery_approval_requires_ready_source`
BEFORE UPDATE OF `status` ON `gallery_items`
WHEN NEW.`status` = 'APPROVED' AND NOT EXISTS (SELECT 1 FROM `assets` WHERE `id` = NEW.`source_asset_id` AND `owner_id` = NEW.`owner_id` AND `status` = 'READY' AND `moderation_status` = 'APPROVED')
BEGIN SELECT RAISE(ABORT, 'gallery source must be an approved ready owned asset'); END;
