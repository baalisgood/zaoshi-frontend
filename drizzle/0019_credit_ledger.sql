CREATE TABLE `credit_ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`entry_type` text NOT NULL,
	`amount` integer NOT NULL,
	`reservation_id` text,
	`job_id` text,
	`item_id` text,
	`attempt_id` text,
	`idempotency_key` text NOT NULL,
	`reason_code` text NOT NULL,
	`price_version` text,
	`actor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `generation_jobs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`item_id`) REFERENCES `generation_job_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`attempt_id`) REFERENCES `generation_attempts`(`id`) ON UPDATE no action ON DELETE restrict,
	CHECK (`entry_type` IN ('CREDIT','RESERVE','SETTLE','RELEASE')),
	CHECK (`amount` BETWEEN 1 AND 1000000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_credit_ledger_owner_idempotency` ON `credit_ledger_entries` (`owner_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_credit_ledger_reservation_event` ON `credit_ledger_entries` (`reservation_id`,`entry_type`) WHERE `reservation_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_credit_ledger_owner_created` ON `credit_ledger_entries` (`owner_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_job_items_billing_reservation` ON `generation_job_items` (`billing_reservation_id`) WHERE `billing_reservation_id` IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_insert_guard`
BEFORE INSERT ON `credit_ledger_entries`
WHEN
  (NEW.`entry_type` = 'CREDIT' AND (
    NEW.`reservation_id` IS NOT NULL OR NEW.`job_id` IS NOT NULL
    OR NEW.`item_id` IS NOT NULL OR NEW.`attempt_id` IS NOT NULL
    OR NEW.`price_version` IS NOT NULL
  ))
  OR (NEW.`entry_type` = 'RESERVE' AND (
    NEW.`reservation_id` IS NULL OR NEW.`job_id` IS NULL OR NEW.`item_id` IS NULL
    OR NEW.`attempt_id` IS NOT NULL OR NEW.`price_version` IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM `generation_job_items` AS item
      WHERE item.`id` = NEW.`item_id` AND item.`job_id` = NEW.`job_id`
        AND item.`owner_id` = NEW.`owner_id` AND item.`execution_kind` = 'provider'
        AND item.`status` IN ('QUEUED','FAILED')
        AND (
          item.`billing_reservation_id` IS NULL
          OR EXISTS (
            SELECT 1 FROM `credit_ledger_entries` AS released
            WHERE released.`owner_id` = item.`owner_id`
              AND released.`reservation_id` = item.`billing_reservation_id`
              AND released.`entry_type` = 'RELEASE'
          )
        )
    )
    OR EXISTS (
      SELECT 1 FROM `credit_ledger_entries` AS reserved
      WHERE reserved.`item_id` = NEW.`item_id` AND reserved.`entry_type` = 'RESERVE'
        AND NOT EXISTS (
          SELECT 1 FROM `credit_ledger_entries` AS terminal
          WHERE terminal.`reservation_id` = reserved.`reservation_id`
            AND terminal.`entry_type` IN ('SETTLE','RELEASE')
        )
    )
  ))
  OR (NEW.`entry_type` = 'SETTLE' AND (
    NEW.`reservation_id` IS NULL OR NEW.`job_id` IS NULL OR NEW.`item_id` IS NULL
    OR NEW.`attempt_id` IS NULL OR NEW.`price_version` IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM `credit_ledger_entries` AS reserved
      JOIN `generation_job_items` AS item ON item.`id` = reserved.`item_id`
      JOIN `generation_output_commits` AS output
        ON output.`item_id` = item.`id` AND output.`attempt_id` = NEW.`attempt_id`
      WHERE reserved.`owner_id` = NEW.`owner_id`
        AND reserved.`entry_type` = 'RESERVE'
        AND reserved.`reservation_id` = NEW.`reservation_id`
        AND reserved.`job_id` = NEW.`job_id` AND reserved.`item_id` = NEW.`item_id`
        AND reserved.`amount` = NEW.`amount`
        AND reserved.`price_version` = NEW.`price_version`
        AND item.`billing_reservation_id` = NEW.`reservation_id`
        AND item.`status` = 'SUCCEEDED' AND item.`current_attempt_id` = NEW.`attempt_id`
        AND output.`state` = 'COMMITTED'
    )
    OR EXISTS (
      SELECT 1 FROM `credit_ledger_entries` AS terminal
      WHERE terminal.`reservation_id` = NEW.`reservation_id`
        AND terminal.`entry_type` IN ('SETTLE','RELEASE')
    )
  ))
  OR (NEW.`entry_type` = 'RELEASE' AND (
    NEW.`reservation_id` IS NULL OR NEW.`job_id` IS NULL OR NEW.`item_id` IS NULL
    OR NEW.`attempt_id` IS NULL OR NEW.`price_version` IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM `credit_ledger_entries` AS reserved
      JOIN `generation_job_items` AS item ON item.`id` = reserved.`item_id`
      JOIN `generation_dead_letter_entries` AS dead
        ON dead.`item_id` = item.`id` AND dead.`attempt_id` = NEW.`attempt_id`
      WHERE reserved.`owner_id` = NEW.`owner_id`
        AND reserved.`entry_type` = 'RESERVE'
        AND reserved.`reservation_id` = NEW.`reservation_id`
        AND reserved.`job_id` = NEW.`job_id` AND reserved.`item_id` = NEW.`item_id`
        AND reserved.`amount` = NEW.`amount`
        AND reserved.`price_version` = NEW.`price_version`
        AND item.`billing_reservation_id` = NEW.`reservation_id`
        AND item.`status` = 'FAILED' AND item.`current_attempt_id` = NEW.`attempt_id`
        AND dead.`job_id` = NEW.`job_id`
    )
    OR EXISTS (
      SELECT 1 FROM `credit_ledger_entries` AS terminal
      WHERE terminal.`reservation_id` = NEW.`reservation_id`
        AND terminal.`entry_type` IN ('SETTLE','RELEASE')
    )
  ))
BEGIN SELECT RAISE(ABORT, 'invalid credit ledger entry'); END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_balance_guard`
BEFORE INSERT ON `credit_ledger_entries`
WHEN NEW.`entry_type` = 'RESERVE' AND COALESCE((
  SELECT SUM(CASE
    WHEN entry.`entry_type` = 'CREDIT' THEN entry.`amount`
    WHEN entry.`entry_type` = 'RESERVE' THEN -entry.`amount`
    WHEN entry.`entry_type` = 'RELEASE' THEN entry.`amount`
    ELSE 0 END)
  FROM `credit_ledger_entries` AS entry
  WHERE entry.`owner_id` = NEW.`owner_id`
), 0) < NEW.`amount`
BEGIN SELECT RAISE(ABORT, 'insufficient credits'); END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_no_update`
BEFORE UPDATE ON `credit_ledger_entries`
BEGIN SELECT RAISE(ABORT, 'credit ledger is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_no_delete`
BEFORE DELETE ON `credit_ledger_entries`
BEGIN SELECT RAISE(ABORT, 'credit ledger is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_bind_reservation`
AFTER INSERT ON `credit_ledger_entries`
WHEN NEW.`entry_type` = 'RESERVE'
BEGIN
  UPDATE `generation_job_items`
     SET `billing_reservation_id` = NEW.`reservation_id`, `updated_at` = unixepoch()
   WHERE `id` = NEW.`item_id` AND `job_id` = NEW.`job_id`
     AND `owner_id` = NEW.`owner_id` AND `execution_kind` = 'provider';
END;
--> statement-breakpoint
CREATE TRIGGER `generation_item_billing_binding_guard`
BEFORE UPDATE OF `billing_reservation_id` ON `generation_job_items`
WHEN NEW.`billing_reservation_id` IS NOT OLD.`billing_reservation_id` AND (
  NEW.`execution_kind` <> 'provider' OR NEW.`billing_reservation_id` IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM `credit_ledger_entries` AS reserved
    WHERE reserved.`owner_id` = NEW.`owner_id`
      AND reserved.`job_id` = NEW.`job_id` AND reserved.`item_id` = NEW.`id`
      AND reserved.`reservation_id` = NEW.`billing_reservation_id`
      AND reserved.`entry_type` = 'RESERVE'
      AND NOT EXISTS (
        SELECT 1 FROM `credit_ledger_entries` AS terminal
        WHERE terminal.`reservation_id` = reserved.`reservation_id`
          AND terminal.`entry_type` IN ('SETTLE','RELEASE')
      )
  )
  OR (OLD.`billing_reservation_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `credit_ledger_entries` AS released
    WHERE released.`owner_id` = OLD.`owner_id`
      AND released.`reservation_id` = OLD.`billing_reservation_id`
      AND released.`entry_type` = 'RELEASE'
  ))
)
BEGIN SELECT RAISE(ABORT, 'invalid generation billing reservation'); END;
--> statement-breakpoint
CREATE TRIGGER `generation_item_billing_claim_guard`
BEFORE UPDATE OF `status` ON `generation_job_items`
WHEN NEW.`execution_kind` = 'provider' AND NEW.`status` = 'LEASED'
  AND OLD.`status` IN ('QUEUED','RETRY_WAIT')
  AND NOT EXISTS (
    SELECT 1 FROM `credit_ledger_entries` AS reserved
    WHERE reserved.`owner_id` = NEW.`owner_id`
      AND reserved.`job_id` = NEW.`job_id` AND reserved.`item_id` = NEW.`id`
      AND reserved.`reservation_id` = NEW.`billing_reservation_id`
      AND reserved.`entry_type` = 'RESERVE'
      AND NOT EXISTS (
        SELECT 1 FROM `credit_ledger_entries` AS terminal
        WHERE terminal.`reservation_id` = reserved.`reservation_id`
          AND terminal.`entry_type` IN ('SETTLE','RELEASE')
      )
  )
BEGIN SELECT RAISE(ABORT, 'generation item has no active credit reservation'); END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_settle_output`
AFTER UPDATE OF `state` ON `generation_output_commits`
WHEN OLD.`state` <> 'COMMITTED' AND NEW.`state` = 'COMMITTED'
  AND EXISTS (
    SELECT 1 FROM `generation_job_items`
    WHERE `id` = NEW.`item_id` AND `execution_kind` = 'provider'
      AND `billing_reservation_id` IS NOT NULL
  )
BEGIN
  INSERT OR IGNORE INTO `credit_ledger_entries`
    (`id`,`owner_id`,`entry_type`,`amount`,`reservation_id`,`job_id`,`item_id`,
     `attempt_id`,`idempotency_key`,`reason_code`,`price_version`,`actor_id`,`request_id`)
  SELECT 'ledger_settle_' || reserved.`reservation_id`, item.`owner_id`, 'SETTLE',
         reserved.`amount`, reserved.`reservation_id`, item.`job_id`, item.`id`,
         NEW.`attempt_id`, 'settle:' || reserved.`reservation_id`,
         'GENERATION_OUTPUT_COMMITTED', reserved.`price_version`, 'system', NEW.`id`
  FROM `generation_job_items` AS item
  JOIN `credit_ledger_entries` AS reserved
    ON reserved.`reservation_id` = item.`billing_reservation_id`
   AND reserved.`entry_type` = 'RESERVE'
  WHERE item.`id` = NEW.`item_id` AND item.`execution_kind` = 'provider';
  SELECT RAISE(ABORT, 'provider output must settle credits')
  WHERE NOT EXISTS (
    SELECT 1 FROM `generation_job_items` AS item
    JOIN `credit_ledger_entries` AS settled
      ON settled.`reservation_id` = item.`billing_reservation_id`
     AND settled.`entry_type` = 'SETTLE'
    WHERE item.`id` = NEW.`item_id`
  );
END;
--> statement-breakpoint
CREATE TRIGGER `credit_ledger_release_dead_letter`
AFTER INSERT ON `generation_dead_letter_entries`
WHEN EXISTS (
  SELECT 1 FROM `generation_job_items`
  WHERE `id` = NEW.`item_id` AND `billing_reservation_id` IS NOT NULL
)
BEGIN
  INSERT OR IGNORE INTO `credit_ledger_entries`
    (`id`,`owner_id`,`entry_type`,`amount`,`reservation_id`,`job_id`,`item_id`,
     `attempt_id`,`idempotency_key`,`reason_code`,`price_version`,`actor_id`,`request_id`)
  SELECT 'ledger_release_' || reserved.`reservation_id`, item.`owner_id`, 'RELEASE',
         reserved.`amount`, reserved.`reservation_id`, item.`job_id`, item.`id`,
         NEW.`attempt_id`, 'release:' || reserved.`reservation_id`,
         'SAFE_BEFORE_PROVIDER_FAILURE', reserved.`price_version`, 'system', NEW.`id`
  FROM `generation_job_items` AS item
  JOIN `credit_ledger_entries` AS reserved
    ON reserved.`reservation_id` = item.`billing_reservation_id`
   AND reserved.`entry_type` = 'RESERVE'
  WHERE item.`id` = NEW.`item_id` AND item.`execution_kind` = 'provider';
  SELECT RAISE(ABORT, 'provider dead letter must release credits')
  WHERE NOT EXISTS (
    SELECT 1 FROM `generation_job_items` AS item
    JOIN `credit_ledger_entries` AS released
      ON released.`reservation_id` = item.`billing_reservation_id`
     AND released.`entry_type` = 'RELEASE'
    WHERE item.`id` = NEW.`item_id`
  );
END;
--> statement-breakpoint
CREATE TRIGGER `generation_queue_admin_action_billing_guard`
BEFORE INSERT ON `generation_queue_admin_actions`
WHEN NEW.`action` = 'REQUEUE_BEFORE_PROVIDER' AND NOT EXISTS (
  SELECT 1 FROM `generation_job_items` AS item
  JOIN `credit_ledger_entries` AS reserved
    ON reserved.`reservation_id` = item.`billing_reservation_id`
   AND reserved.`entry_type` = 'RESERVE'
  WHERE item.`id` = NEW.`item_id` AND item.`job_id` = NEW.`job_id`
    AND item.`owner_id` = reserved.`owner_id`
    AND NOT EXISTS (
      SELECT 1 FROM `credit_ledger_entries` AS terminal
      WHERE terminal.`reservation_id` = reserved.`reservation_id`
        AND terminal.`entry_type` IN ('SETTLE','RELEASE')
    )
)
BEGIN SELECT RAISE(ABORT, 'safe requeue requires a new credit reservation'); END;
