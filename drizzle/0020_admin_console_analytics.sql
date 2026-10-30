CREATE TABLE `admin_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`detail_json` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CHECK (`action` IN ('USER_UPDATE','CREDIT_GRANT','CREDIT_COMPENSATION')),
	CHECK (`target_type` IN ('USER','CREDIT_ACCOUNT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_admin_audit_action` ON `admin_audit_events` (`action_id`);
--> statement-breakpoint
CREATE INDEX `idx_admin_audit_created` ON `admin_audit_events` (`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `admin_audit_no_update`
BEFORE UPDATE ON `admin_audit_events`
BEGIN SELECT RAISE(ABORT, 'admin audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `admin_audit_no_delete`
BEFORE DELETE ON `admin_audit_events`
BEGIN SELECT RAISE(ABORT, 'admin audit is append-only'); END;
--> statement-breakpoint
CREATE TABLE `site_page_views` (
	`id` text PRIMARY KEY NOT NULL,
	`visitor_hash` text NOT NULL,
	`path` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	`duration_seconds` integer,
	CHECK (length(`path`) BETWEEN 1 AND 80),
	CHECK (`duration_seconds` IS NULL OR `duration_seconds` BETWEEN 0 AND 1800),
	CHECK (`ended_at` IS NULL OR `ended_at` >= `started_at`)
);
--> statement-breakpoint
CREATE INDEX `idx_site_page_views_started` ON `site_page_views` (`started_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_site_page_views_visitor_started` ON `site_page_views` (`visitor_hash`,`started_at`);
--> statement-breakpoint
CREATE INDEX `idx_users_status_created` ON `users` (`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_credit_ledger_created` ON `credit_ledger_entries` (`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_generation_job_items_status_updated` ON `generation_job_items` (`status`,`updated_at`,`id`);
