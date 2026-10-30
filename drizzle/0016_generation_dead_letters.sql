CREATE TABLE `generation_dead_letter_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`job_id` text NOT NULL,
	`classification` text NOT NULL,
	`reason_code` text NOT NULL,
	`retry_class` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`attempt_count` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`opened_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `generation_job_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attempt_id`) REFERENCES `generation_attempts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_dead_letter_item_attempt` ON `generation_dead_letter_entries` (`item_id`,`attempt_id`);
--> statement-breakpoint
CREATE INDEX `idx_generation_dead_letter_opened` ON `generation_dead_letter_entries` (`opened_at`,`id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `generation_dead_letter_entries`
  (`id`,`item_id`,`attempt_id`,`job_id`,`classification`,`reason_code`,`retry_class`,
   `attempt_no`,`attempt_count`,`max_attempts`,`opened_at`)
SELECT 'dead_' || attempt.`id`, item.`id`, attempt.`id`, item.`job_id`,
       'SAFE_BEFORE_PROVIDER_FAILURE',
       COALESCE(item.`last_error_code`, attempt.`error_code`, 'GENERATION_FAILED'),
       attempt.`retry_class`, attempt.`attempt_no`, item.`attempt_count`, item.`max_attempts`,
       COALESCE(item.`finished_at`, attempt.`finished_at`, unixepoch())
FROM `generation_job_items` AS item
JOIN `generation_attempts` AS attempt ON attempt.`id` = item.`current_attempt_id`
WHERE item.`execution_kind` = 'provider' AND item.`status` = 'FAILED'
  AND attempt.`item_id` = item.`id` AND attempt.`state` = 'FAILED'
  AND attempt.`retry_class` IN ('safe-before-provider','not-retryable','attempts-exhausted')
  AND attempt.`provider` IS NULL AND attempt.`model` IS NULL
  AND attempt.`provider_account_slot` IS NULL AND attempt.`provider_request_id` IS NULL
  AND attempt.`provider_started_at` IS NULL AND attempt.`provider_responded_at` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `generation_attempts` AS historical
    WHERE historical.`item_id` = item.`id` AND (
      historical.`provider` IS NOT NULL OR historical.`model` IS NOT NULL
      OR historical.`provider_account_slot` IS NOT NULL
      OR historical.`provider_request_id` IS NOT NULL
      OR historical.`provider_started_at` IS NOT NULL
      OR historical.`provider_responded_at` IS NOT NULL
      OR historical.`state` IN ('PROVIDER_DISPATCHING','PROVIDER_RESPONDED','STORING','AMBIGUOUS','SUCCEEDED')
      OR historical.`retry_class` = 'ambiguous-after-provider'
    )
  )
  AND NOT EXISTS (SELECT 1 FROM `generation_output_commits` AS output WHERE output.`item_id` = item.`id`)
  AND NOT EXISTS (SELECT 1 FROM `generation_job_outputs` AS output WHERE output.`job_id` = item.`job_id` AND output.`ordinal` = item.`ordinal`)
  AND NOT EXISTS (SELECT 1 FROM `generation_reconciliation_cases` AS reconciliation WHERE reconciliation.`item_id` = item.`id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `generation_dead_letter_entries`
  (`id`,`item_id`,`attempt_id`,`job_id`,`classification`,`reason_code`,`retry_class`,
   `attempt_no`,`attempt_count`,`max_attempts`,`opened_at`)
SELECT 'dead_' || attempt.`id`, action.`item_id`, attempt.`id`, action.`job_id`,
       'SAFE_BEFORE_PROVIDER_FAILURE',
       COALESCE(attempt.`error_code`, 'GENERATION_FAILED'), attempt.`retry_class`,
       action.`from_attempt_no`, action.`from_attempt_count`, item.`max_attempts`, action.`created_at`
FROM `generation_queue_admin_actions` AS action
JOIN `generation_job_items` AS item ON item.`id` = action.`item_id` AND item.`job_id` = action.`job_id`
JOIN `generation_attempts` AS attempt ON attempt.`id` = action.`attempt_id` AND attempt.`item_id` = action.`item_id`
WHERE action.`action` = 'REQUEUE_BEFORE_PROVIDER'
  AND action.`from_status` = 'FAILED' AND action.`to_status` = 'QUEUED'
  AND action.`reason_code` = 'SAFE_BEFORE_PROVIDER'
  AND item.`execution_kind` = 'provider'
  AND attempt.`state` = 'FAILED'
  AND attempt.`retry_class` IN ('safe-before-provider','not-retryable','attempts-exhausted')
  AND attempt.`provider` IS NULL AND attempt.`model` IS NULL
  AND attempt.`provider_account_slot` IS NULL AND attempt.`provider_request_id` IS NULL
  AND attempt.`provider_started_at` IS NULL AND attempt.`provider_responded_at` IS NULL;
--> statement-breakpoint
CREATE TRIGGER `generation_dead_letter_insert_guard`
BEFORE INSERT ON `generation_dead_letter_entries`
WHEN NEW.`id` IS NOT 'dead_' || NEW.`attempt_id`
  OR NEW.`classification` IS NOT 'SAFE_BEFORE_PROVIDER_FAILURE'
  OR NOT EXISTS (
    SELECT 1 FROM `generation_job_items` AS item
    JOIN `generation_attempts` AS attempt ON attempt.`id` = NEW.`attempt_id`
    WHERE item.`id` = NEW.`item_id` AND item.`job_id` = NEW.`job_id`
      AND attempt.`item_id` = item.`id`
      AND item.`execution_kind` = 'provider'
      AND attempt.`state` = 'FAILED'
      AND attempt.`retry_class` IN ('safe-before-provider','not-retryable','attempts-exhausted')
      AND NEW.`retry_class` = attempt.`retry_class`
      AND NEW.`attempt_no` = attempt.`attempt_no`
      AND NEW.`reason_code` IN (
        COALESCE(item.`last_error_code`, attempt.`error_code`, 'GENERATION_FAILED'),
        COALESCE(attempt.`error_code`, 'GENERATION_FAILED')
      )
      AND attempt.`provider` IS NULL AND attempt.`model` IS NULL
      AND attempt.`provider_account_slot` IS NULL AND attempt.`provider_request_id` IS NULL
      AND attempt.`provider_started_at` IS NULL AND attempt.`provider_responded_at` IS NULL
      AND (
        (item.`status` = 'FAILED' AND item.`current_attempt_id` = attempt.`id`
          AND NEW.`attempt_count` = item.`attempt_count` AND NEW.`max_attempts` = item.`max_attempts`
          AND NOT EXISTS (
            SELECT 1 FROM `generation_attempts` AS historical
            WHERE historical.`item_id` = item.`id` AND (
              historical.`provider` IS NOT NULL OR historical.`model` IS NOT NULL
              OR historical.`provider_account_slot` IS NOT NULL
              OR historical.`provider_request_id` IS NOT NULL
              OR historical.`provider_started_at` IS NOT NULL
              OR historical.`provider_responded_at` IS NOT NULL
              OR historical.`state` IN ('PROVIDER_DISPATCHING','PROVIDER_RESPONDED','STORING','AMBIGUOUS','SUCCEEDED')
              OR historical.`retry_class` = 'ambiguous-after-provider'
            )
          )
          AND NOT EXISTS (SELECT 1 FROM `generation_output_commits` AS output WHERE output.`item_id` = item.`id`)
          AND NOT EXISTS (SELECT 1 FROM `generation_job_outputs` AS output WHERE output.`job_id` = item.`job_id` AND output.`ordinal` = item.`ordinal`)
          AND NOT EXISTS (SELECT 1 FROM `generation_reconciliation_cases` AS reconciliation WHERE reconciliation.`item_id` = item.`id`))
        OR EXISTS (
          SELECT 1 FROM `generation_queue_admin_actions` AS action
          WHERE action.`item_id` = item.`id` AND action.`attempt_id` = attempt.`id`
            AND action.`job_id` = item.`job_id` AND action.`action` = 'REQUEUE_BEFORE_PROVIDER'
            AND action.`from_status` = 'FAILED' AND action.`to_status` = 'QUEUED'
            AND action.`reason_code` = 'SAFE_BEFORE_PROVIDER'
            AND NEW.`attempt_count` = action.`from_attempt_count`
            AND NEW.`attempt_no` = action.`from_attempt_no`
            AND NEW.`max_attempts` = item.`max_attempts`
        )
      )
  )
BEGIN SELECT RAISE(ABORT, 'invalid generation dead letter insert'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_dead_letter_no_duplicate_insert`
BEFORE INSERT ON `generation_dead_letter_entries`
WHEN EXISTS (
  SELECT 1 FROM `generation_dead_letter_entries`
  WHERE `id` = NEW.`id` OR (`item_id` = NEW.`item_id` AND `attempt_id` = NEW.`attempt_id`)
)
BEGIN SELECT RAISE(ABORT, 'generation dead letter already exists'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_dead_letter_no_update`
BEFORE UPDATE ON `generation_dead_letter_entries`
BEGIN SELECT RAISE(ABORT, 'generation dead letters are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_dead_letter_no_delete`
BEFORE DELETE ON `generation_dead_letter_entries`
BEGIN SELECT RAISE(ABORT, 'generation dead letters are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_dead_letter_open`
AFTER UPDATE OF `status` ON `generation_job_items`
WHEN NEW.`execution_kind` = 'provider' AND NEW.`status` = 'FAILED' AND OLD.`status` <> 'FAILED'
  AND NEW.`current_attempt_id` IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO `generation_dead_letter_entries`
    (`id`,`item_id`,`attempt_id`,`job_id`,`classification`,`reason_code`,`retry_class`,
     `attempt_no`,`attempt_count`,`max_attempts`,`opened_at`)
  SELECT 'dead_' || attempt.`id`, NEW.`id`, attempt.`id`, NEW.`job_id`,
         'SAFE_BEFORE_PROVIDER_FAILURE',
         COALESCE(NEW.`last_error_code`, attempt.`error_code`, 'GENERATION_FAILED'),
         attempt.`retry_class`, attempt.`attempt_no`, NEW.`attempt_count`, NEW.`max_attempts`,
         COALESCE(NEW.`finished_at`, attempt.`finished_at`, unixepoch())
  FROM `generation_attempts` AS attempt
  WHERE attempt.`id` = NEW.`current_attempt_id` AND attempt.`item_id` = NEW.`id`
    AND attempt.`state` = 'FAILED'
    AND attempt.`retry_class` IN ('safe-before-provider','not-retryable','attempts-exhausted')
    AND attempt.`provider` IS NULL AND attempt.`model` IS NULL
    AND attempt.`provider_account_slot` IS NULL AND attempt.`provider_request_id` IS NULL
    AND attempt.`provider_started_at` IS NULL AND attempt.`provider_responded_at` IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM `generation_attempts` AS historical
      WHERE historical.`item_id` = NEW.`id` AND (
        historical.`provider` IS NOT NULL OR historical.`model` IS NOT NULL
        OR historical.`provider_account_slot` IS NOT NULL
        OR historical.`provider_request_id` IS NOT NULL
        OR historical.`provider_started_at` IS NOT NULL
        OR historical.`provider_responded_at` IS NOT NULL
        OR historical.`state` IN ('PROVIDER_DISPATCHING','PROVIDER_RESPONDED','STORING','AMBIGUOUS','SUCCEEDED')
        OR historical.`retry_class` = 'ambiguous-after-provider'
      )
    )
    AND NOT EXISTS (SELECT 1 FROM `generation_output_commits` AS output WHERE output.`item_id` = NEW.`id`)
    AND NOT EXISTS (SELECT 1 FROM `generation_job_outputs` AS output WHERE output.`job_id` = NEW.`job_id` AND output.`ordinal` = NEW.`ordinal`)
    AND NOT EXISTS (SELECT 1 FROM `generation_reconciliation_cases` AS reconciliation WHERE reconciliation.`item_id` = NEW.`id`);
  SELECT RAISE(ABORT, 'provider failed item must create a generation dead letter')
  WHERE NOT EXISTS (
    SELECT 1 FROM `generation_dead_letter_entries` AS dead
    WHERE dead.`id` = 'dead_' || NEW.`current_attempt_id`
      AND dead.`item_id` = NEW.`id`
      AND dead.`attempt_id` = NEW.`current_attempt_id`
      AND dead.`job_id` = NEW.`job_id`
  );
END;
--> statement-breakpoint
CREATE TABLE `_generation_dead_letter_migration_guard` (`id` integer PRIMARY KEY NOT NULL);
--> statement-breakpoint
CREATE TRIGGER `_generation_dead_letter_migration_guard_reject`
BEFORE INSERT ON `_generation_dead_letter_migration_guard`
WHEN EXISTS (
  SELECT 1 FROM `generation_job_items` AS item
  WHERE item.`execution_kind` = 'provider' AND item.`status` = 'FAILED'
    AND (
      item.`current_attempt_id` IS NULL OR NOT EXISTS (
        SELECT 1 FROM `generation_dead_letter_entries` AS dead
        WHERE dead.`id` = 'dead_' || item.`current_attempt_id`
          AND dead.`item_id` = item.`id`
          AND dead.`attempt_id` = item.`current_attempt_id`
          AND dead.`job_id` = item.`job_id`
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'unclassified provider failed item blocks dead letter migration'); END;
--> statement-breakpoint
INSERT INTO `_generation_dead_letter_migration_guard` (`id`) VALUES (1);
--> statement-breakpoint
DROP TRIGGER `_generation_dead_letter_migration_guard_reject`;
--> statement-breakpoint
DROP TABLE `_generation_dead_letter_migration_guard`;
