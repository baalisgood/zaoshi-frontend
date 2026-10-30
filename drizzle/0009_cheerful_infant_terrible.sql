CREATE TABLE `generation_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`lease_token` text NOT NULL,
	`lease_generation` integer NOT NULL,
	`state` text DEFAULT 'STARTED' NOT NULL,
	`provider` text,
	`model` text,
	`provider_account_slot` text,
	`provider_request_id` text,
	`retry_class` text,
	`error_code` text,
	`error_message` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`heartbeat_at` integer,
	`provider_started_at` integer,
	`provider_responded_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `generation_job_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_attempts_item_attempt` ON `generation_attempts` (`item_id`,`attempt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_attempts_lease_token` ON `generation_attempts` (`lease_token`);--> statement-breakpoint
CREATE INDEX `idx_generation_attempts_item_started` ON `generation_attempts` (`item_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `generation_job_items` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`provider_preference` text NOT NULL,
	`provider_key` text NOT NULL,
	`status` text DEFAULT 'QUEUED' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
	`notified_at` integer,
	`lease_token` text,
	`lease_generation` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`heartbeat_at` integer,
	`current_attempt_id` text,
	`last_error_code` text,
	`last_error_message` text,
	`last_error_retryable` integer,
	`billing_reservation_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_job_items_job_ordinal` ON `generation_job_items` (`job_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_generation_job_items_runnable` ON `generation_job_items` (`status`,`next_attempt_at`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_generation_job_items_provider_lease` ON `generation_job_items` (`provider_key`,`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_generation_job_items_owner_lease` ON `generation_job_items` (`owner_id`,`status`,`lease_expires_at`);