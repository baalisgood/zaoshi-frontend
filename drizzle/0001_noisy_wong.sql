ALTER TABLE `generation_jobs` ADD `depth_asset_id` text REFERENCES assets(id);--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `normal_asset_id` text REFERENCES assets(id);--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `workflow_type` text DEFAULT 'concept' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `resolution` text DEFAULT '1K' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `aspect_ratio` text DEFAULT '4:3' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `quality` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `lamp_state` text DEFAULT 'mixed' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_jobs` ADD `color_temperature_kelvin` integer DEFAULT 4000 NOT NULL;