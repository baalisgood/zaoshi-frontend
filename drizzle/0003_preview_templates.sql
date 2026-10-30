ALTER TABLE `generation_jobs` ADD `purpose` text DEFAULT 'final' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `source_job_id` text;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `promoted_from_asset_id` text;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `effective_resolution` text DEFAULT '1K' NOT NULL;--> statement-breakpoint
UPDATE `generation_jobs` SET `effective_resolution` = `resolution` WHERE `effective_resolution` = '1K' AND `resolution` <> '1K';--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_source_job` ON `generation_jobs` (`source_job_id`);--> statement-breakpoint
CREATE TABLE `studio_templates` (`id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `workflow_type` text NOT NULL, `name` text NOT NULL, `config_json` text NOT NULL, `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL);--> statement-breakpoint
CREATE INDEX `idx_studio_templates_owner` ON `studio_templates` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `template_shares` (`id` text PRIMARY KEY NOT NULL, `template_id` text NOT NULL REFERENCES `studio_templates`(`id`) ON DELETE cascade, `token_hash` text NOT NULL UNIQUE, `revoked_at` text, `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL);--> statement-breakpoint
CREATE INDEX `idx_template_shares_template` ON `template_shares` (`template_id`);
