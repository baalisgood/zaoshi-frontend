CREATE TABLE `generation_queue_admin_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`item_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`job_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`from_attempt_no` integer NOT NULL,
	`from_attempt_count` integer NOT NULL,
	`reason_code` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `generation_job_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attempt_id`) REFERENCES `generation_attempts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_queue_admin_action_id` ON `generation_queue_admin_actions` (`action_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_queue_admin_item_attempt_action` ON `generation_queue_admin_actions` (`item_id`,`attempt_id`,`action`);
--> statement-breakpoint
CREATE INDEX `idx_generation_queue_admin_item_created` ON `generation_queue_admin_actions` (`item_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `generation_queue_admin_action_no_duplicate_insert`
BEFORE INSERT ON `generation_queue_admin_actions`
WHEN EXISTS (
  SELECT 1 FROM `generation_queue_admin_actions`
  WHERE `id` = NEW.`id` OR `action_id` = NEW.`action_id`
     OR (`item_id` = NEW.`item_id` AND `attempt_id` = NEW.`attempt_id` AND `action` = NEW.`action`)
)
BEGIN SELECT RAISE(ABORT, 'generation queue admin action already exists'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_queue_admin_action_safe_insert`
BEFORE INSERT ON `generation_queue_admin_actions`
WHEN NEW.`action` IS NOT 'REQUEUE_BEFORE_PROVIDER'
  OR NEW.`from_status` IS NOT 'FAILED'
  OR NEW.`to_status` IS NOT 'QUEUED'
  OR NEW.`reason_code` IS NOT 'SAFE_BEFORE_PROVIDER'
  OR NOT EXISTS (
    SELECT 1
    FROM `generation_job_items` AS item
    JOIN `generation_attempts` AS attempt ON attempt.`id` = item.`current_attempt_id`
    WHERE item.`id` = NEW.`item_id`
      AND item.`job_id` = NEW.`job_id`
      AND attempt.`id` = NEW.`attempt_id`
      AND attempt.`item_id` = item.`id`
      AND attempt.`attempt_no` = NEW.`from_attempt_no`
      AND attempt.`lease_generation` = item.`lease_generation`
      AND item.`attempt_count` = NEW.`from_attempt_count`
      AND item.`execution_kind` = 'provider'
      AND item.`status` = 'FAILED'
      AND item.`attempt_count` < item.`max_attempts`
      AND item.`lease_token` IS NULL
      AND item.`lease_owner` IS NULL
      AND item.`lease_expires_at` IS NULL
      AND attempt.`state` = 'FAILED'
      AND attempt.`retry_class` IN ('safe-before-provider','not-retryable')
      AND attempt.`provider` IS NULL
      AND attempt.`model` IS NULL
      AND attempt.`provider_account_slot` IS NULL
      AND attempt.`provider_request_id` IS NULL
      AND attempt.`provider_started_at` IS NULL
      AND attempt.`provider_responded_at` IS NULL
      AND item.`last_error_code` IS attempt.`error_code`
      AND item.`last_error_message` IS attempt.`error_message`
      AND NOT EXISTS (
        SELECT 1 FROM `generation_attempts` AS historical
        WHERE historical.`item_id` = item.`id`
          AND (
            historical.`provider` IS NOT NULL
            OR historical.`model` IS NOT NULL
            OR historical.`provider_account_slot` IS NOT NULL
            OR historical.`provider_request_id` IS NOT NULL
            OR historical.`provider_started_at` IS NOT NULL
            OR historical.`provider_responded_at` IS NOT NULL
            OR historical.`state` IN ('PROVIDER_DISPATCHING','PROVIDER_RESPONDED','STORING','AMBIGUOUS','SUCCEEDED')
            OR historical.`retry_class` = 'ambiguous-after-provider'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM `generation_output_commits` AS output
        WHERE output.`item_id` = item.`id`
      )
      AND NOT EXISTS (
        SELECT 1 FROM `generation_job_outputs` AS output
        WHERE output.`job_id` = item.`job_id` AND output.`ordinal` = item.`ordinal`
      )
      AND NOT EXISTS (
        SELECT 1 FROM `generation_reconciliation_cases` AS reconciliation
        WHERE reconciliation.`item_id` = item.`id`
      )
  )
BEGIN SELECT RAISE(ABORT, 'generation item is not safe to requeue'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_queue_admin_action_apply_requeue`
AFTER INSERT ON `generation_queue_admin_actions`
BEGIN
  UPDATE `generation_job_items`
     SET `status` = 'QUEUED', `next_attempt_at` = unixepoch(),
         `notified_at` = NULL, `lease_generation` = `lease_generation` + 1,
         `heartbeat_at` = NULL, `last_error_code` = NULL,
         `last_error_message` = NULL, `last_error_retryable` = NULL,
         `updated_at` = unixepoch(), `finished_at` = NULL
   WHERE `id` = NEW.`item_id` AND `current_attempt_id` = NEW.`attempt_id`
     AND `status` = 'FAILED';
END;
--> statement-breakpoint
CREATE TRIGGER `generation_queue_admin_actions_no_update`
BEFORE UPDATE ON `generation_queue_admin_actions`
BEGIN SELECT RAISE(ABORT, 'generation queue admin actions are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_queue_admin_actions_no_delete`
BEFORE DELETE ON `generation_queue_admin_actions`
BEGIN SELECT RAISE(ABORT, 'generation queue admin actions are append-only'); END;
