CREATE TABLE `generation_output_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`lease_generation` integer NOT NULL,
	`upload_request_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`provider_request_id` text,
	`prompt_template_version` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`state` text DEFAULT 'PREPARED' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`object_stored_at` integer,
	`committed_at` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `generation_job_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `generation_attempts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generation_output_commits_item_id_unique` ON `generation_output_commits` (`item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `generation_output_commits_attempt_id_unique` ON `generation_output_commits` (`attempt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `generation_output_commits_upload_request_id_unique` ON `generation_output_commits` (`upload_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `generation_output_commits_asset_id_unique` ON `generation_output_commits` (`asset_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `generation_output_commits_storage_key_unique` ON `generation_output_commits` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_generation_output_commits_state_updated` ON `generation_output_commits` (`state`,`updated_at`);