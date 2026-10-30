ALTER TABLE `generation_attempts` ADD `claim_request_id` text;--> statement-breakpoint
ALTER TABLE `generation_attempts` ADD `claim_worker_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_generation_attempts_claim_request` ON `generation_attempts` (`claim_request_id`);
