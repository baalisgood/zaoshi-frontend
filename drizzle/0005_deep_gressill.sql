CREATE TABLE `gallery_items` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_asset_id` text NOT NULL,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`public_prompt` text,
	`consent_version` text NOT NULL,
	`image_consent_at` text NOT NULL,
	`prompt_consent_at` text,
	`thumb_key` text NOT NULL,
	`display_key` text NOT NULL,
	`thumb_mime` text DEFAULT 'image/webp' NOT NULL,
	`display_mime` text DEFAULT 'image/webp' NOT NULL,
	`thumb_bytes` integer NOT NULL,
	`display_bytes` integer NOT NULL,
	`thumb_sha256` text NOT NULL,
	`display_sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`submitted_at` text NOT NULL,
	`reviewed_at` text,
	`published_at` text,
	`rejected_at` text,
	`revoked_at` text,
	`updated_at` text NOT NULL,
	`reviewer_owner_id` text,
	`review_note` text,
	FOREIGN KEY (`source_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_gallery_public_feed` ON `gallery_items` (`status`,`published_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_gallery_public_category_feed` ON `gallery_items` (`status`,`category`,`published_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_gallery_owner_submissions` ON `gallery_items` (`owner_id`,`submitted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_gallery_active_source` ON `gallery_items` (`source_asset_id`) WHERE `status` IN ('PENDING', 'APPROVED');
