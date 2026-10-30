CREATE TABLE `user_generation_limits` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`daily_output_limit` integer DEFAULT 20 NOT NULL,
	`max_pending_outputs` integer DEFAULT 4 NOT NULL,
	`active_concurrency_limit` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CHECK (`daily_output_limit` BETWEEN 1 AND 1000),
	CHECK (`max_pending_outputs` BETWEEN 1 AND 100),
	CHECK (`active_concurrency_limit` BETWEEN 1 AND 16),
	CHECK (`enabled` IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `generation_quota_admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL UNIQUE,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`day_start` text NOT NULL,
	`units` integer NOT NULL,
	`daily_limit_snapshot` integer NOT NULL,
	`pending_limit_snapshot` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CHECK (`units` BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_quota_owner_idempotency` ON `generation_quota_admissions` (`owner_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_generation_quota_owner_day` ON `generation_quota_admissions` (`owner_id`,`day_start`,`created_at`);
