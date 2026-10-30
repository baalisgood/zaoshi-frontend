CREATE TABLE `recharge_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`product_code` text NOT NULL,
	`catalog_version` text NOT NULL,
	`amount_fen` integer NOT NULL,
	`credits` integer NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`idempotency_key` text NOT NULL,
	`credit_ledger_entry_id` text,
	`expires_at` integer NOT NULL,
	`paid_at` integer,
	`credited_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`credit_ledger_entry_id`) REFERENCES `credit_ledger_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	CHECK (`provider` IN ('WECHAT_PAY','ALIPAY')),
	CHECK (`catalog_version` = 'cn-recharge-v1-20260913'),
	CHECK (`amount_fen` BETWEEN 1 AND 100000000),
	CHECK (`credits` BETWEEN 1 AND 1000000000),
	CHECK (
		(`product_code` = 'CNY10' AND `amount_fen` = 1000 AND `credits` = 1000)
		OR (`product_code` = 'CNY30' AND `amount_fen` = 3000 AND `credits` = 3000)
		OR (`product_code` = 'CNY50' AND `amount_fen` = 5000 AND `credits` = 5000)
		OR (`product_code` = 'CNY100' AND `amount_fen` = 10000 AND `credits` = 10000)
	),
	CHECK (`status` IN ('PENDING','PAID','CREDITED','CANCELED','EXPIRED')),
	CHECK (`expires_at` > `created_at`),
	CHECK (
		(`status` = 'PENDING' AND `paid_at` IS NULL AND `credited_at` IS NULL AND `credit_ledger_entry_id` IS NULL)
		OR (`status` = 'PAID' AND `paid_at` BETWEEN `created_at` AND `expires_at` AND `credited_at` IS NULL AND `credit_ledger_entry_id` IS NULL)
		OR (`status` = 'CREDITED' AND `paid_at` BETWEEN `created_at` AND `expires_at` AND `credited_at` >= `paid_at` AND `credit_ledger_entry_id` IS NOT NULL)
		OR (`status` IN ('CANCELED','EXPIRED') AND `paid_at` IS NULL AND `credited_at` IS NULL AND `credit_ledger_entry_id` IS NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_recharge_orders_owner_idempotency` ON `recharge_orders` (`owner_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_recharge_orders_credit_ledger` ON `recharge_orders` (`credit_ledger_entry_id`) WHERE `credit_ledger_entry_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_recharge_orders_owner_created` ON `recharge_orders` (`owner_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_recharge_orders_status_updated` ON `recharge_orders` (`status`,`updated_at`,`id`);
--> statement-breakpoint
CREATE TABLE `recharge_payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`provider_transaction_id` text NOT NULL,
	`amount_fen` integer NOT NULL,
	`payload_hash` text NOT NULL,
	`paid_at` integer NOT NULL,
	`verified_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `recharge_orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CHECK (`provider` IN ('WECHAT_PAY','ALIPAY')),
	CHECK (`amount_fen` BETWEEN 1 AND 100000000),
	CHECK (length(`payload_hash`) = 64 AND `payload_hash` NOT GLOB '*[^0-9a-f]*'),
	CHECK (`paid_at` > 0 AND `verified_at` >= `paid_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_recharge_payment_provider_event` ON `recharge_payment_events` (`provider`,`provider_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_recharge_payment_provider_transaction` ON `recharge_payment_events` (`provider`,`provider_transaction_id`);
--> statement-breakpoint
CREATE INDEX `idx_recharge_payment_order` ON `recharge_payment_events` (`order_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `recharge_orders_mutation_guard`
BEFORE UPDATE ON `recharge_orders`
WHEN NOT (
  NEW.`id` = OLD.`id` AND NEW.`owner_id` = OLD.`owner_id`
  AND NEW.`provider` = OLD.`provider` AND NEW.`product_code` = OLD.`product_code`
  AND NEW.`catalog_version` = OLD.`catalog_version` AND NEW.`amount_fen` = OLD.`amount_fen`
  AND NEW.`credits` = OLD.`credits` AND NEW.`idempotency_key` = OLD.`idempotency_key`
  AND NEW.`expires_at` = OLD.`expires_at` AND NEW.`created_at` = OLD.`created_at`
  AND NEW.`updated_at` >= OLD.`updated_at`
  AND (
    (OLD.`status` = 'PENDING' AND NEW.`status` = 'PAID'
      AND OLD.`paid_at` IS NULL AND NEW.`paid_at` IS NOT NULL
      AND NEW.`updated_at` >= NEW.`paid_at`
      AND NEW.`credited_at` IS NULL AND NEW.`credit_ledger_entry_id` IS NULL
      AND EXISTS (
        SELECT 1 FROM `recharge_payment_events` AS payment
        WHERE payment.`order_id` = NEW.`id` AND payment.`provider` = NEW.`provider`
          AND payment.`amount_fen` = NEW.`amount_fen` AND payment.`paid_at` = NEW.`paid_at`
      ))
    OR (OLD.`status` = 'PAID' AND NEW.`status` = 'CREDITED'
      AND NEW.`paid_at` = OLD.`paid_at` AND NEW.`credited_at` IS NOT NULL
      AND NEW.`credited_at` >= NEW.`paid_at` AND NEW.`updated_at` >= NEW.`credited_at`
      AND NEW.`credit_ledger_entry_id` = 'ledger_recharge_' || NEW.`id`)
    OR (OLD.`status` = 'PENDING' AND NEW.`status` IN ('CANCELED','EXPIRED')
      AND NEW.`paid_at` IS NULL AND NEW.`credited_at` IS NULL AND NEW.`credit_ledger_entry_id` IS NULL)
  )
)
BEGIN SELECT RAISE(ABORT, 'invalid recharge order transition'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_orders_no_delete`
BEFORE DELETE ON `recharge_orders`
BEGIN SELECT RAISE(ABORT, 'recharge orders are append-preserved'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_payment_events_insert_guard`
BEFORE INSERT ON `recharge_payment_events`
WHEN NOT EXISTS (
  SELECT 1 FROM `recharge_payment_events` AS existing
  WHERE existing.`provider` = NEW.`provider`
    AND existing.`provider_event_id` = NEW.`provider_event_id`
    AND existing.`order_id` = NEW.`order_id`
    AND existing.`provider_transaction_id` = NEW.`provider_transaction_id`
    AND existing.`amount_fen` = NEW.`amount_fen`
    AND existing.`payload_hash` = NEW.`payload_hash`
    AND existing.`paid_at` = NEW.`paid_at`
)
AND NOT EXISTS (
  SELECT 1 FROM `recharge_orders` AS order_record
  WHERE order_record.`id` = NEW.`order_id`
    AND order_record.`provider` = NEW.`provider`
    AND order_record.`amount_fen` = NEW.`amount_fen`
    AND order_record.`status` = 'PENDING'
    AND NEW.`paid_at` >= order_record.`created_at`
    AND NEW.`paid_at` <= order_record.`expires_at`
    AND NEW.`verified_at` >= order_record.`created_at`
)
BEGIN SELECT RAISE(ABORT, 'payment event does not match a payable order'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_payment_events_no_update`
BEFORE UPDATE ON `recharge_payment_events`
BEGIN SELECT RAISE(ABORT, 'payment events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_payment_events_no_delete`
BEFORE DELETE ON `recharge_payment_events`
BEGIN SELECT RAISE(ABORT, 'payment events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_credit_insert_guard`
BEFORE INSERT ON `credit_ledger_entries`
WHEN NEW.`reason_code` = 'RECHARGE_PAID' AND NOT EXISTS (
  SELECT 1 FROM `recharge_orders` AS order_record
  JOIN `recharge_payment_events` AS payment ON payment.`order_id` = order_record.`id`
  WHERE order_record.`owner_id` = NEW.`owner_id`
    AND order_record.`status` = 'PAID'
    AND order_record.`credits` = NEW.`amount`
    AND NEW.`entry_type` = 'CREDIT'
    AND NEW.`id` = 'ledger_recharge_' || order_record.`id`
    AND NEW.`idempotency_key` = 'recharge:' || order_record.`id`
    AND NEW.`actor_id` = 'payment:' || order_record.`provider`
    AND NEW.`request_id` = payment.`provider_event_id`
)
BEGIN SELECT RAISE(ABORT, 'recharge credit has no verified payment'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_orders_credit_guard`
BEFORE UPDATE OF `status` ON `recharge_orders`
WHEN NEW.`status` = 'CREDITED' AND NOT EXISTS (
  SELECT 1 FROM `credit_ledger_entries` AS ledger
  WHERE ledger.`id` = NEW.`credit_ledger_entry_id`
    AND ledger.`owner_id` = NEW.`owner_id`
    AND ledger.`entry_type` = 'CREDIT'
    AND ledger.`amount` = NEW.`credits`
    AND ledger.`idempotency_key` = 'recharge:' || NEW.`id`
    AND ledger.`reason_code` = 'RECHARGE_PAID'
    AND ledger.`actor_id` = 'payment:' || NEW.`provider`
)
BEGIN SELECT RAISE(ABORT, 'credited recharge order has no matching ledger entry'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_payment_events_credit_order`
AFTER INSERT ON `recharge_payment_events`
BEGIN
  UPDATE `recharge_orders`
     SET `status` = 'PAID', `paid_at` = NEW.`paid_at`, `updated_at` = NEW.`verified_at`
   WHERE `id` = NEW.`order_id` AND `provider` = NEW.`provider`
     AND `amount_fen` = NEW.`amount_fen` AND `status` = 'PENDING';

  INSERT INTO `credit_ledger_entries`
    (`id`,`owner_id`,`entry_type`,`amount`,`idempotency_key`,`reason_code`,`actor_id`,`request_id`)
  SELECT 'ledger_recharge_' || order_record.`id`, order_record.`owner_id`, 'CREDIT',
         order_record.`credits`, 'recharge:' || order_record.`id`, 'RECHARGE_PAID',
         'payment:' || order_record.`provider`, NEW.`provider_event_id`
  FROM `recharge_orders` AS order_record
  WHERE order_record.`id` = NEW.`order_id` AND order_record.`status` = 'PAID';

  UPDATE `recharge_orders`
     SET `status` = 'CREDITED', `credited_at` = NEW.`verified_at`,
         `credit_ledger_entry_id` = 'ledger_recharge_' || NEW.`order_id`,
         `updated_at` = NEW.`verified_at`
   WHERE `id` = NEW.`order_id` AND `status` = 'PAID';

  SELECT RAISE(ABORT, 'verified payment did not credit order')
  WHERE NOT EXISTS (
    SELECT 1 FROM `recharge_orders`
    WHERE `id` = NEW.`order_id` AND `status` = 'CREDITED'
  );
END;
