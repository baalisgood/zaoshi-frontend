CREATE TABLE `generation_internal_nonces` (
	`nonce_hash` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_generation_internal_nonces_expires` ON `generation_internal_nonces` (`expires_at`);