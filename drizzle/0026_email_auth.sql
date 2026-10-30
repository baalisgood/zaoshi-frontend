CREATE TABLE `auth_email_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_hash` text NOT NULL,
	`purpose` text NOT NULL,
	`answer_hash` text NOT NULL,
	`browser_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`attempt_by` text,
	`delivered` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`consumed_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_auth_email_challenge_expiry` ON `auth_email_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_email_credentials` (
	`email` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`password_hash` text NOT NULL,
	`verified_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_email_credentials_user_id_unique` ON `auth_email_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_email_rate_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL
);
