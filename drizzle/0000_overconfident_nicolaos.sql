CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'READY' NOT NULL,
	`original_file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`parent_asset_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_storage_key_unique` ON `assets` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_assets_owner_created` ON `assets` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_assets_owner_kind` ON `assets` (`owner_id`,`kind`);--> statement-breakpoint
CREATE TABLE `generation_job_outputs` (
	`job_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_job_outputs_job_ordinal` ON `generation_job_outputs` (`job_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_job_outputs_asset` ON `generation_job_outputs` (`asset_id`);--> statement-breakpoint
CREATE INDEX `idx_generation_job_outputs_job` ON `generation_job_outputs` (`job_id`);--> statement-breakpoint
CREATE TABLE `generation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_asset_id` text NOT NULL,
	`reference_asset_id` text,
	`mask_asset_id` text,
	`style_preset_id` text NOT NULL,
	`lighting_preset` text NOT NULL,
	`preservation_mode` text NOT NULL,
	`provider_preference` text NOT NULL,
	`edit_instruction` text,
	`output_count` integer NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`completed_output_count` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`provider` text,
	`model` text,
	`provider_request_id` text,
	`prompt_template_version` text,
	`error_code` text,
	`error_message` text,
	`error_retryable` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`source_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reference_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`mask_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_jobs_owner_idempotency` ON `generation_jobs` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_owner_created` ON `generation_jobs` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_status_updated` ON `generation_jobs` (`status`,`updated_at`);