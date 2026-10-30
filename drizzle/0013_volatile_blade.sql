CREATE TABLE `generation_acceptance_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`scenario` text NOT NULL,
	`fixture_sha256` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `generation_job_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generation_acceptance_runs_item_id_unique` ON `generation_acceptance_runs` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_generation_acceptance_runs_updated` ON `generation_acceptance_runs` (`updated_at`);--> statement-breakpoint
ALTER TABLE `generation_job_items` ADD `execution_kind` text DEFAULT 'provider' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_generation_job_items_execution_runnable` ON `generation_job_items` (`execution_kind`,`status`,`next_attempt_at`,`created_at`,`id`);--> statement-breakpoint
CREATE TRIGGER `generation_job_items_execution_kind_insert`
BEFORE INSERT ON `generation_job_items`
WHEN NEW.`execution_kind` NOT IN ('provider', 'acceptance')
BEGIN
  SELECT RAISE(ABORT, 'invalid generation execution kind');
END;--> statement-breakpoint
CREATE TRIGGER `generation_job_items_execution_kind_update`
BEFORE UPDATE OF `execution_kind` ON `generation_job_items`
WHEN NEW.`execution_kind` NOT IN ('provider', 'acceptance')
BEGIN
  SELECT RAISE(ABORT, 'invalid generation execution kind');
END;--> statement-breakpoint
CREATE TRIGGER `generation_acceptance_runs_scenario_insert`
BEFORE INSERT ON `generation_acceptance_runs`
WHEN NEW.`scenario` NOT IN ('happy_path', 'claim_ack_loss', 'output_ack_loss', 'spool_recovery', 'reconciliation')
BEGIN
  SELECT RAISE(ABORT, 'invalid generation acceptance scenario');
END;--> statement-breakpoint
CREATE TRIGGER `generation_acceptance_runs_scenario_update`
BEFORE UPDATE OF `scenario` ON `generation_acceptance_runs`
WHEN NEW.`scenario` NOT IN ('happy_path', 'claim_ack_loss', 'output_ack_loss', 'spool_recovery', 'reconciliation')
BEGIN
  SELECT RAISE(ABORT, 'invalid generation acceptance scenario');
END;
