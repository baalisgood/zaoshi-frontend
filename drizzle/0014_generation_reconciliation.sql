CREATE TABLE `generation_reconciliation_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`job_id` text NOT NULL,
	`reason_code` text NOT NULL,
	`provider` text,
	`model` text,
	`provider_request_id` text,
	`state` text DEFAULT 'OPEN' NOT NULL,
	`resolution` text,
	`version` integer DEFAULT 1 NOT NULL,
	`opened_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `generation_job_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attempt_id`) REFERENCES `generation_attempts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_reconciliation_item_attempt` ON `generation_reconciliation_cases` (`item_id`,`attempt_id`);
--> statement-breakpoint
CREATE INDEX `idx_generation_reconciliation_state_updated` ON `generation_reconciliation_cases` (`state`,`updated_at`,`id`);
--> statement-breakpoint
CREATE TABLE `generation_reconciliation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`action_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`note` text,
	`request_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `generation_reconciliation_cases`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_reconciliation_event_action` ON `generation_reconciliation_events` (`case_id`,`action_id`);
--> statement-breakpoint
CREATE INDEX `idx_generation_reconciliation_events_case_created` ON `generation_reconciliation_events` (`case_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER `generation_reconciliation_case_state_insert`
BEFORE INSERT ON `generation_reconciliation_cases`
WHEN NEW.`state` <> 'OPEN' OR NEW.`resolution` IS NOT NULL
  OR NEW.`resolved_at` IS NOT NULL OR NEW.`version` <> 1
  OR NOT EXISTS (
    SELECT 1 FROM `generation_job_items` AS item
    JOIN `generation_attempts` AS attempt ON attempt.`id` = NEW.`attempt_id`
    WHERE item.`id` = NEW.`item_id` AND item.`job_id` = NEW.`job_id`
      AND item.`execution_kind` = 'provider'
      AND item.`status` = 'RECONCILIATION_REQUIRED'
      AND item.`current_attempt_id` = attempt.`id`
      AND attempt.`item_id` = item.`id`
  )
BEGIN SELECT RAISE(ABORT, 'invalid reconciliation case insert'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_reconciliation_case_state_update`
BEFORE UPDATE ON `generation_reconciliation_cases`
WHEN OLD.`state` IS NOT 'OPEN' OR NEW.`state` IS NOT 'CLOSED'
  OR NEW.`resolution` IS NOT 'OUTPUT_COMMIT_RECOVERED'
  OR NEW.`version` IS NOT OLD.`version` + 1 OR NEW.`resolved_at` IS NULL
  OR NEW.`id` IS NOT OLD.`id` OR NEW.`item_id` IS NOT OLD.`item_id`
  OR NEW.`attempt_id` IS NOT OLD.`attempt_id` OR NEW.`job_id` IS NOT OLD.`job_id`
  OR NEW.`reason_code` IS NOT OLD.`reason_code`
  OR NEW.`provider` IS NOT OLD.`provider` OR NEW.`model` IS NOT OLD.`model`
  OR NEW.`provider_request_id` IS NOT OLD.`provider_request_id`
  OR NEW.`opened_at` IS NOT OLD.`opened_at`
  OR NOT EXISTS (
    SELECT 1 FROM `generation_output_commits` AS output
    JOIN `generation_job_items` AS item ON item.`id` = output.`item_id`
    WHERE output.`state` = 'COMMITTED' AND output.`item_id` = NEW.`item_id`
      AND output.`attempt_id` = NEW.`attempt_id`
      AND output.`lease_generation` = item.`lease_generation`
      AND item.`execution_kind` = 'provider' AND item.`status` = 'SUCCEEDED'
      AND item.`current_attempt_id` = NEW.`attempt_id`
  )
BEGIN SELECT RAISE(ABORT, 'invalid reconciliation case update'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_reconciliation_events_no_duplicate_insert`
BEFORE INSERT ON `generation_reconciliation_events`
WHEN EXISTS (
  SELECT 1 FROM `generation_reconciliation_events`
  WHERE `id` = NEW.`id` OR (`case_id` = NEW.`case_id` AND `action_id` = NEW.`action_id`)
)
BEGIN SELECT RAISE(ABORT, 'reconciliation event already exists'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_reconciliation_events_no_update`
BEFORE UPDATE ON `generation_reconciliation_events`
BEGIN SELECT RAISE(ABORT, 'reconciliation events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_reconciliation_events_no_delete`
BEFORE DELETE ON `generation_reconciliation_events`
BEGIN SELECT RAISE(ABORT, 'reconciliation events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_reconciliation_case_open`
AFTER UPDATE OF `status` ON `generation_job_items`
WHEN NEW.`execution_kind` = 'provider'
 AND NEW.`status` = 'RECONCILIATION_REQUIRED'
 AND OLD.`status` <> 'RECONCILIATION_REQUIRED'
 AND NEW.`current_attempt_id` IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO `generation_reconciliation_cases`
    (`id`,`item_id`,`attempt_id`,`job_id`,`reason_code`,`provider`,`model`,`provider_request_id`)
  SELECT 'recon_' || NEW.`current_attempt_id`, NEW.`id`, NEW.`current_attempt_id`, NEW.`job_id`,
         COALESCE(NEW.`last_error_code`, attempt.`error_code`, 'AMBIGUOUS_PROVIDER_OUTCOME'),
         attempt.`provider`, attempt.`model`, attempt.`provider_request_id`
  FROM `generation_attempts` AS attempt WHERE attempt.`id` = NEW.`current_attempt_id`;
  INSERT INTO `generation_reconciliation_events`
    (`id`,`case_id`,`action_id`,`action`,`actor_id`,`from_state`,`to_state`,`note`)
  SELECT 'event_open_' || NEW.`current_attempt_id`, 'recon_' || NEW.`current_attempt_id`,
         'system-open-' || NEW.`current_attempt_id`, 'OPENED', 'system', NULL, 'OPEN',
         'Queue state requires manual reconciliation.'
  WHERE NOT EXISTS (SELECT 1 FROM `generation_reconciliation_events` WHERE `id` = 'event_open_' || NEW.`current_attempt_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `generation_reconciliation_case_output_recovered`
AFTER UPDATE OF `state` ON `generation_output_commits`
WHEN OLD.`state` <> 'COMMITTED' AND NEW.`state` = 'COMMITTED'
 AND EXISTS (
   SELECT 1 FROM `generation_job_items` AS item
   WHERE item.`id` = NEW.`item_id`
     AND item.`execution_kind` = 'provider'
     AND item.`status` = 'SUCCEEDED'
     AND item.`current_attempt_id` = NEW.`attempt_id`
     AND item.`lease_generation` = NEW.`lease_generation`
 )
 AND EXISTS (
   SELECT 1 FROM `generation_reconciliation_cases` AS reconciliation
   WHERE reconciliation.`item_id` = NEW.`item_id`
     AND reconciliation.`attempt_id` = NEW.`attempt_id`
     AND reconciliation.`state` = 'OPEN'
 )
BEGIN
  UPDATE `generation_reconciliation_cases`
     SET `state` = 'CLOSED', `resolution` = 'OUTPUT_COMMIT_RECOVERED',
         `version` = `version` + 1, `updated_at` = unixepoch(), `resolved_at` = unixepoch()
   WHERE `item_id` = NEW.`item_id` AND `attempt_id` = NEW.`attempt_id` AND `state` = 'OPEN';
  INSERT INTO `generation_reconciliation_events`
    (`id`,`case_id`,`action_id`,`action`,`actor_id`,`from_state`,`to_state`,`note`)
  SELECT 'event_recovered_' || NEW.`attempt_id`, 'recon_' || NEW.`attempt_id`,
         'system-recovered-' || NEW.`attempt_id`, 'OUTPUT_COMMIT_RECOVERED', 'system',
         'OPEN', 'CLOSED', 'Fenced output commit recovered the item.'
  WHERE NOT EXISTS (SELECT 1 FROM `generation_reconciliation_events` WHERE `id` = 'event_recovered_' || NEW.`attempt_id`);
END;
--> statement-breakpoint
INSERT OR IGNORE INTO `generation_reconciliation_cases`
  (`id`,`item_id`,`attempt_id`,`job_id`,`reason_code`,`provider`,`model`,`provider_request_id`,`opened_at`,`updated_at`)
SELECT 'recon_' || attempt.`id`, item.`id`, attempt.`id`, item.`job_id`,
       COALESCE(item.`last_error_code`, attempt.`error_code`, 'AMBIGUOUS_PROVIDER_OUTCOME'),
       attempt.`provider`, attempt.`model`, attempt.`provider_request_id`,
       COALESCE(attempt.`finished_at`, unixepoch()), unixepoch()
FROM `generation_job_items` AS item
JOIN `generation_attempts` AS attempt ON attempt.`id` = item.`current_attempt_id`
WHERE item.`execution_kind` = 'provider' AND item.`status` = 'RECONCILIATION_REQUIRED';
--> statement-breakpoint
INSERT INTO `generation_reconciliation_events`
  (`id`,`case_id`,`action_id`,`action`,`actor_id`,`from_state`,`to_state`,`note`)
SELECT 'event_open_' || `attempt_id`, `id`, 'system-open-' || `attempt_id`,
       'OPENED', 'system', NULL, 'OPEN', 'Backfilled from queue state.'
FROM `generation_reconciliation_cases` AS reconciliation
WHERE NOT EXISTS (
  SELECT 1 FROM `generation_reconciliation_events` AS event
  WHERE event.`id` = 'event_open_' || reconciliation.`attempt_id`
);
