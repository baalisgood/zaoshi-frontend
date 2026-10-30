CREATE TABLE `recharge_orders_v2` (
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
	CHECK (`catalog_version` = 'cn-recharge-v2-20261006'),
	CHECK (`amount_fen` BETWEEN 1 AND 100000000),
	CHECK (`credits` BETWEEN 1 AND 1000000000),
	CHECK (
		(`product_code` = 'CNY20' AND `amount_fen` = 2000 AND `credits` = 2000)
		OR (`product_code` = 'CNY50' AND `amount_fen` = 5000 AND `credits` = 5100)
		OR (`product_code` = 'CNY100' AND `amount_fen` = 10000 AND `credits` = 10500)
		OR (`product_code` = 'CNY200' AND `amount_fen` = 20000 AND `credits` = 21400)
		OR (`product_code` = 'CNY500' AND `amount_fen` = 50000 AND `credits` = 55000)
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
CREATE UNIQUE INDEX `uidx_recharge_orders_v2_owner_idempotency` ON `recharge_orders_v2` (`owner_id`,`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_recharge_orders_v2_credit_ledger` ON `recharge_orders_v2` (`credit_ledger_entry_id`) WHERE `credit_ledger_entry_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_recharge_orders_v2_owner_created` ON `recharge_orders_v2` (`owner_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_recharge_orders_v2_status_updated` ON `recharge_orders_v2` (`status`,`updated_at`,`id`);
--> statement-breakpoint
CREATE TABLE `recharge_payment_events_v2` (
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
	FOREIGN KEY (`order_id`) REFERENCES `recharge_orders_v2`(`id`) ON UPDATE no action ON DELETE restrict,
	CHECK (`provider` IN ('WECHAT_PAY','ALIPAY')),
	CHECK (`amount_fen` BETWEEN 1 AND 100000000),
	CHECK (length(`payload_hash`) = 64 AND `payload_hash` NOT GLOB '*[^0-9a-f]*'),
	CHECK (`paid_at` > 0 AND `verified_at` >= `paid_at`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_recharge_payment_v2_v2_provider_event` ON `recharge_payment_events_v2` (`provider`,`provider_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_recharge_payment_v2_v2_provider_transaction` ON `recharge_payment_events_v2` (`provider`,`provider_transaction_id`);
--> statement-breakpoint
CREATE INDEX `idx_recharge_payment_v2_order` ON `recharge_payment_events_v2` (`order_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `recharge_orders_v2_mutation_guard`
BEFORE UPDATE ON `recharge_orders_v2`
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
        SELECT 1 FROM `recharge_payment_events_v2` AS payment
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
CREATE TRIGGER `recharge_orders_v2_no_delete`
BEFORE DELETE ON `recharge_orders_v2`
BEGIN SELECT RAISE(ABORT, 'recharge orders are append-preserved'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_payment_events_v2_insert_guard`
BEFORE INSERT ON `recharge_payment_events_v2`
WHEN NOT EXISTS (
  SELECT 1 FROM `recharge_payment_events_v2` AS existing
  WHERE existing.`provider` = NEW.`provider`
    AND existing.`provider_event_id` = NEW.`provider_event_id`
    AND existing.`order_id` = NEW.`order_id`
    AND existing.`provider_transaction_id` = NEW.`provider_transaction_id`
    AND existing.`amount_fen` = NEW.`amount_fen`
    AND existing.`payload_hash` = NEW.`payload_hash`
    AND existing.`paid_at` = NEW.`paid_at`
)
AND NOT EXISTS (
  SELECT 1 FROM `recharge_orders_v2` AS order_record
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
CREATE TRIGGER `recharge_payment_events_v2_no_update`
BEFORE UPDATE ON `recharge_payment_events_v2`
BEGIN SELECT RAISE(ABORT, 'payment events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_payment_events_v2_no_delete`
BEFORE DELETE ON `recharge_payment_events_v2`
BEGIN SELECT RAISE(ABORT, 'payment events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `recharge_orders_v2_credit_guard`
BEFORE UPDATE OF `status` ON `recharge_orders_v2`
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
CREATE TRIGGER `recharge_payment_events_v2_credit_order`
AFTER INSERT ON `recharge_payment_events_v2`
BEGIN
  UPDATE `recharge_orders_v2`
     SET `status` = 'PAID', `paid_at` = NEW.`paid_at`, `updated_at` = NEW.`verified_at`
   WHERE `id` = NEW.`order_id` AND `provider` = NEW.`provider`
     AND `amount_fen` = NEW.`amount_fen` AND `status` = 'PENDING';

  INSERT INTO `credit_ledger_entries`
    (`id`,`owner_id`,`entry_type`,`amount`,`idempotency_key`,`reason_code`,`actor_id`,`request_id`)
  SELECT 'ledger_recharge_' || order_record.`id`, order_record.`owner_id`, 'CREDIT',
         order_record.`credits`, 'recharge:' || order_record.`id`, 'RECHARGE_PAID',
         'payment:' || order_record.`provider`, NEW.`provider_event_id`
  FROM `recharge_orders_v2` AS order_record
  WHERE order_record.`id` = NEW.`order_id` AND order_record.`status` = 'PAID';

  UPDATE `recharge_orders_v2`
     SET `status` = 'CREDITED', `credited_at` = NEW.`verified_at`,
         `credit_ledger_entry_id` = 'ledger_recharge_' || NEW.`order_id`,
         `updated_at` = NEW.`verified_at`
   WHERE `id` = NEW.`order_id` AND `status` = 'PAID';

  SELECT RAISE(ABORT, 'verified payment did not credit order')
  WHERE NOT EXISTS (
    SELECT 1 FROM `recharge_orders_v2`
    WHERE `id` = NEW.`order_id` AND `status` = 'CREDITED'
  );
END;

--> statement-breakpoint
DROP TRIGGER `recharge_credit_insert_guard`;
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
) AND NOT EXISTS (
  SELECT 1 FROM `recharge_orders_v2` AS order_record
  JOIN `recharge_payment_events_v2` AS payment ON payment.`order_id` = order_record.`id`
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
CREATE TRIGGER `recharge_orders_cross_version_key_guard` BEFORE INSERT ON `recharge_orders`
WHEN EXISTS (SELECT 1 FROM `recharge_orders_v2` WHERE owner_id = NEW.owner_id AND idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'cross-version recharge key conflict'); END;

--> statement-breakpoint
CREATE TRIGGER `recharge_orders_v2_cross_version_key_guard` BEFORE INSERT ON `recharge_orders_v2`
WHEN EXISTS (SELECT 1 FROM `recharge_orders` WHERE owner_id = NEW.owner_id AND idempotency_key = NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT, 'cross-version recharge key conflict'); END;

--> statement-breakpoint
CREATE TRIGGER `recharge_payment_events_cross_version_payment_guard` BEFORE INSERT ON `recharge_payment_events`
WHEN EXISTS (SELECT 1 FROM `recharge_payment_events_v2` WHERE provider = NEW.provider AND (provider_event_id = NEW.provider_event_id OR provider_transaction_id = NEW.provider_transaction_id))
BEGIN SELECT RAISE(ABORT, 'cross-version payment conflict'); END;

--> statement-breakpoint
CREATE TRIGGER `recharge_payment_events_v2_cross_version_payment_guard` BEFORE INSERT ON `recharge_payment_events_v2`
WHEN EXISTS (SELECT 1 FROM `recharge_payment_events` WHERE provider = NEW.provider AND (provider_event_id = NEW.provider_event_id OR provider_transaction_id = NEW.provider_transaction_id))
BEGIN SELECT RAISE(ABORT, 'cross-version payment conflict'); END;

--> statement-breakpoint
CREATE TABLE recharge_native_sessions (
 order_id TEXT PRIMARY KEY NOT NULL REFERENCES recharge_orders_v2(id) ON DELETE RESTRICT,
 code_url TEXT NOT NULL CHECK(length(code_url) BETWEEN 1 AND 2048),
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
--> statement-breakpoint
CREATE TABLE recharge_reconciliation_events (
 id TEXT PRIMARY KEY NOT NULL, order_id TEXT NOT NULL REFERENCES recharge_orders_v2(id) ON DELETE RESTRICT, provider TEXT NOT NULL CHECK(provider='WECHAT_PAY'),
 provider_transaction_id TEXT NOT NULL UNIQUE, amount_fen INTEGER NOT NULL CHECK(amount_fen>0),
 paid_at INTEGER NOT NULL, verified_at INTEGER NOT NULL CHECK(verified_at>=paid_at),
 facts_hash TEXT NOT NULL CHECK(length(facts_hash)=64 AND facts_hash NOT GLOB '*[^0-9a-f]*'),
 reason TEXT NOT NULL CHECK(reason IN ('OUTSIDE_PAYMENT_WINDOW','ORDER_NOT_PAYABLE'))
);
--> statement-breakpoint
CREATE TRIGGER recharge_reconciliation_no_update BEFORE UPDATE ON recharge_reconciliation_events BEGIN SELECT RAISE(ABORT,'reconciliation is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER recharge_reconciliation_no_delete BEFORE DELETE ON recharge_reconciliation_events BEGIN SELECT RAISE(ABORT,'reconciliation is append-only'); END;

--> statement-breakpoint
CREATE TRIGGER recharge_native_no_update BEFORE UPDATE ON recharge_native_sessions BEGIN SELECT RAISE(ABORT,'native code is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER recharge_native_no_delete BEFORE DELETE ON recharge_native_sessions BEGIN SELECT RAISE(ABORT,'native code is preserved'); END;
--> statement-breakpoint
CREATE TRIGGER recharge_reconciliation_payment_guard BEFORE INSERT ON recharge_reconciliation_events
WHEN EXISTS(SELECT 1 FROM recharge_payment_events WHERE provider=NEW.provider AND provider_transaction_id=NEW.provider_transaction_id)
 OR EXISTS(SELECT 1 FROM recharge_payment_events_v2 WHERE provider=NEW.provider AND provider_transaction_id=NEW.provider_transaction_id)
 OR NOT EXISTS(SELECT 1 FROM recharge_orders_v2 o WHERE o.id=NEW.order_id AND o.provider=NEW.provider AND o.amount_fen=NEW.amount_fen AND (o.status IN ('CANCELED','EXPIRED') OR NEW.paid_at<o.created_at OR NEW.paid_at>o.expires_at))
BEGIN SELECT RAISE(ABORT,'reconciliation payment conflict'); END;

--> statement-breakpoint
CREATE TRIGGER recharge_payment_events_reconciliation_guard BEFORE INSERT ON recharge_payment_events
WHEN EXISTS(SELECT 1 FROM recharge_reconciliation_events WHERE provider=NEW.provider AND provider_transaction_id=NEW.provider_transaction_id)
BEGIN SELECT RAISE(ABORT,'payment already requires reconciliation'); END;

--> statement-breakpoint
CREATE TRIGGER recharge_payment_events_v2_reconciliation_guard BEFORE INSERT ON recharge_payment_events_v2
WHEN EXISTS(SELECT 1 FROM recharge_reconciliation_events WHERE provider=NEW.provider AND provider_transaction_id=NEW.provider_transaction_id)
BEGIN SELECT RAISE(ABORT,'payment already requires reconciliation'); END;
