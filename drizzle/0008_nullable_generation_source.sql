-- D1-safe rebuild: D1 does not support relying on PRAGMA foreign_keys=OFF.
PRAGMA defer_foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `generation_jobs_new` (
  `id` text PRIMARY KEY NOT NULL, `owner_id` text NOT NULL, `source_asset_id` text REFERENCES assets(id) ON DELETE RESTRICT,
  `reference_asset_id` text REFERENCES assets(id) ON DELETE RESTRICT, `additional_references_json` text DEFAULT '[]' NOT NULL,
  `mask_asset_id` text REFERENCES assets(id) ON DELETE RESTRICT, `depth_asset_id` text REFERENCES assets(id) ON DELETE RESTRICT, `normal_asset_id` text REFERENCES assets(id) ON DELETE RESTRICT,
  `workflow_type` text DEFAULT 'concept' NOT NULL, `purpose` text DEFAULT 'final' NOT NULL, `source_job_id` text, `promoted_from_asset_id` text,
  `resolution` text DEFAULT '1K' NOT NULL, `effective_resolution` text DEFAULT '1K' NOT NULL, `aspect_ratio` text DEFAULT '4:3' NOT NULL, `quality` text DEFAULT 'standard' NOT NULL, `visual_realism` text DEFAULT 'photorealistic' NOT NULL, `lamp_state` text DEFAULT 'mixed' NOT NULL, `color_temperature_kelvin` integer DEFAULT 4000 NOT NULL, `style_preset_id` text NOT NULL, `lighting_preset` text NOT NULL, `preservation_mode` text NOT NULL, `provider_preference` text NOT NULL, `edit_instruction` text, `custom_prompt` text, `output_count` integer NOT NULL, `advanced_settings_json` text DEFAULT '{"version":1,"geometryFidelity":"balanced","cameraPolicy":"locked","furnishingDensity":"balanced","materialExpression":"natural","lightingContrast":"balanced"}' NOT NULL, `status` text DEFAULT 'QUEUED' NOT NULL, `completed_output_count` integer DEFAULT 0 NOT NULL, `idempotency_key` text NOT NULL, `request_hash` text NOT NULL, `provider` text, `model` text, `provider_request_id` text, `prompt_template_version` text, `error_code` text, `error_message` text, `error_retryable` integer, `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL, `started_at` text, `finished_at` text
);
--> statement-breakpoint
CREATE TABLE `generation_job_outputs_new` (
  `job_id` text NOT NULL REFERENCES generation_jobs_new(id) ON DELETE CASCADE,
  `asset_id` text NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  `ordinal` integer NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
UPDATE `generation_jobs` SET `additional_references_json` = '[]' WHERE `additional_references_json` IS NULL;
--> statement-breakpoint
INSERT INTO `generation_jobs_new` (`id`, `owner_id`, `source_asset_id`, `reference_asset_id`, `additional_references_json`, `mask_asset_id`, `depth_asset_id`, `normal_asset_id`, `workflow_type`, `purpose`, `source_job_id`, `promoted_from_asset_id`, `resolution`, `effective_resolution`, `aspect_ratio`, `quality`, `visual_realism`, `lamp_state`, `color_temperature_kelvin`, `style_preset_id`, `lighting_preset`, `preservation_mode`, `provider_preference`, `edit_instruction`, `custom_prompt`, `output_count`, `advanced_settings_json`, `status`, `completed_output_count`, `idempotency_key`, `request_hash`, `provider`, `model`, `provider_request_id`, `prompt_template_version`, `error_code`, `error_message`, `error_retryable`, `created_at`, `updated_at`, `started_at`, `finished_at`)
SELECT `id`, `owner_id`, `source_asset_id`, `reference_asset_id`, COALESCE(`additional_references_json`, '[]'), `mask_asset_id`, `depth_asset_id`, `normal_asset_id`, `workflow_type`, `purpose`, `source_job_id`, `promoted_from_asset_id`, `resolution`, `effective_resolution`, `aspect_ratio`, `quality`, `visual_realism`, `lamp_state`, `color_temperature_kelvin`, `style_preset_id`, `lighting_preset`, `preservation_mode`, `provider_preference`, `edit_instruction`, `custom_prompt`, `output_count`, `advanced_settings_json`, `status`, `completed_output_count`, `idempotency_key`, `request_hash`, `provider`, `model`, `provider_request_id`, `prompt_template_version`, `error_code`, `error_message`, `error_retryable`, `created_at`, `updated_at`, `started_at`, `finished_at` FROM `generation_jobs`;
--> statement-breakpoint
INSERT INTO `generation_job_outputs_new` (`job_id`, `asset_id`, `ordinal`, `created_at`) SELECT `job_id`, `asset_id`, `ordinal`, `created_at` FROM `generation_job_outputs`;
--> statement-breakpoint
DROP TABLE `generation_job_outputs`;
--> statement-breakpoint
DROP TABLE `generation_jobs`;
--> statement-breakpoint
ALTER TABLE `generation_jobs_new` RENAME TO `generation_jobs`;
--> statement-breakpoint
ALTER TABLE `generation_job_outputs_new` RENAME TO `generation_job_outputs`;
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_jobs_owner_idempotency` ON `generation_jobs` (`owner_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_owner_created` ON `generation_jobs` (`owner_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_owner_workflow_created` ON `generation_jobs` (`owner_id`,`workflow_type`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_status_updated` ON `generation_jobs` (`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_generation_jobs_source_job` ON `generation_jobs` (`source_job_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_job_outputs_job_ordinal` ON `generation_job_outputs` (`job_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_job_outputs_asset` ON `generation_job_outputs` (`asset_id`);
--> statement-breakpoint
CREATE INDEX `idx_generation_job_outputs_job` ON `generation_job_outputs` (`job_id`);
--> statement-breakpoint
PRAGMA foreign_key_check;
--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
