CREATE TABLE generation_moderation_rejections (
 commit_id TEXT PRIMARY KEY NOT NULL REFERENCES generation_output_commits(id) ON DELETE RESTRICT,
 item_id TEXT NOT NULL REFERENCES generation_job_items(id) ON DELETE RESTRICT,
 attempt_id TEXT NOT NULL REFERENCES generation_attempts(id) ON DELETE RESTRICT,
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
 owner_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE RESTRICT,
 lease_generation INTEGER NOT NULL, lease_token TEXT NOT NULL,
 reservation_id TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), price_version TEXT NOT NULL,
 content_sha256 TEXT NOT NULL, sanitization_version TEXT NOT NULL,
 policy_version TEXT NOT NULL, request_id TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('Review','Block')),
 recovery INTEGER NOT NULL CHECK(recovery IN (0,1)), checked_at INTEGER NOT NULL DEFAULT(unixepoch()),
 UNIQUE(item_id,attempt_id,lease_generation)
);
--> statement-breakpoint
CREATE TRIGGER generation_moderation_rejection_insert_guard BEFORE INSERT ON generation_moderation_rejections
WHEN NOT EXISTS (
 SELECT 1 FROM generation_output_commits oc
 JOIN generation_job_items item ON item.id=oc.item_id
 JOIN generation_attempts attempt ON attempt.id=oc.attempt_id
 JOIN assets asset ON asset.id=oc.asset_id
 JOIN asset_moderation_evidence evidence ON evidence.asset_id=asset.id
 JOIN credit_ledger_entries reserved ON reserved.reservation_id=item.billing_reservation_id AND reserved.entry_type='RESERVE'
 WHERE oc.id=NEW.commit_id AND oc.state='OBJECT_STORED'
 AND item.id=NEW.item_id AND item.job_id=NEW.job_id AND item.owner_id=NEW.owner_id AND item.execution_kind='provider' AND item.status='PERSISTING'
 AND item.current_attempt_id=NEW.attempt_id AND item.lease_generation=NEW.lease_generation AND item.lease_token=NEW.lease_token
 AND (item.lease_expires_at>unixepoch() OR NEW.recovery=1)
 AND attempt.id=NEW.attempt_id AND attempt.item_id=item.id AND attempt.lease_generation=NEW.lease_generation AND attempt.lease_token=NEW.lease_token AND attempt.state IN ('PROVIDER_RESPONDED','STORING')
 AND oc.attempt_id=attempt.id AND oc.lease_generation=NEW.lease_generation
 AND asset.id=NEW.asset_id AND asset.owner_id=NEW.owner_id AND asset.kind='output' AND asset.status='PENDING'
 AND asset.storage_key=oc.storage_key AND asset.sha256=oc.sha256 AND asset.sha256=NEW.content_sha256 AND asset.byte_size=oc.byte_size
 AND asset.sanitization_version=oc.sanitization_version AND asset.sanitization_version=NEW.sanitization_version
 AND evidence.content_sha256=NEW.content_sha256 AND evidence.policy_version=NEW.policy_version AND evidence.request_id=NEW.request_id AND evidence.decision=NEW.decision
 AND length(NEW.policy_version)=36 AND substr(NEW.policy_version,1,20)='tencent-20261006-v1:' AND substr(NEW.policy_version,-16) NOT GLOB '*[^0-9a-f]*' AND NEW.sanitization_version='canonical-image-v1'
 AND reserved.owner_id=NEW.owner_id AND reserved.job_id=NEW.job_id AND reserved.item_id=NEW.item_id AND reserved.reservation_id=NEW.reservation_id AND reserved.amount=NEW.amount AND reserved.price_version=NEW.price_version
 AND NOT EXISTS(SELECT 1 FROM generation_job_outputs output WHERE output.job_id=item.job_id AND output.ordinal=item.ordinal)
 AND NOT EXISTS(SELECT 1 FROM credit_ledger_entries terminal WHERE terminal.reservation_id=NEW.reservation_id AND terminal.entry_type IN ('SETTLE','RELEASE'))
)
BEGIN SELECT RAISE(ABORT,'invalid moderation rejection receipt'); END;
--> statement-breakpoint
CREATE TRIGGER generation_moderation_rejection_no_update BEFORE UPDATE ON generation_moderation_rejections BEGIN SELECT RAISE(ABORT,'moderation rejection is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER generation_moderation_rejection_no_delete BEFORE DELETE ON generation_moderation_rejections BEGIN SELECT RAISE(ABORT,'moderation rejection is preserved'); END;

--> statement-breakpoint
DROP TRIGGER credit_ledger_insert_guard;
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
    OR (NOT EXISTS (
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
    ) AND NOT EXISTS (
      SELECT 1 FROM generation_moderation_rejections rejection
      JOIN credit_ledger_entries reserved ON reserved.reservation_id=rejection.reservation_id AND reserved.entry_type='RESERVE'
      JOIN generation_job_items item ON item.id=rejection.item_id
      JOIN generation_attempts attempt ON attempt.id=rejection.attempt_id
      JOIN generation_output_commits oc ON oc.id=rejection.commit_id
      WHERE rejection.owner_id=NEW.owner_id AND rejection.job_id=NEW.job_id AND rejection.item_id=NEW.item_id AND rejection.attempt_id=NEW.attempt_id AND rejection.reservation_id=NEW.reservation_id
      AND reserved.owner_id=NEW.owner_id AND reserved.job_id=NEW.job_id AND reserved.item_id=NEW.item_id AND reserved.amount=NEW.amount AND reserved.price_version=NEW.price_version
      AND rejection.amount=NEW.amount AND rejection.price_version=NEW.price_version
      AND item.status='FAILED' AND item.current_attempt_id=rejection.attempt_id AND item.lease_generation=rejection.lease_generation AND item.billing_reservation_id=NEW.reservation_id
      AND attempt.state='FAILED' AND attempt.lease_generation=rejection.lease_generation
      AND oc.state='REJECTED' AND oc.attempt_id=rejection.attempt_id AND oc.lease_generation=rejection.lease_generation
      AND NEW.id='ledger_release_'||NEW.reservation_id AND NEW.idempotency_key='release:'||NEW.reservation_id
      AND NEW.reason_code='OUTPUT_MODERATION_REJECTED' AND NEW.actor_id='system' AND NEW.request_id=rejection.commit_id
    ))
    OR EXISTS (
      SELECT 1 FROM `credit_ledger_entries` AS terminal
      WHERE terminal.`reservation_id` = NEW.`reservation_id`
        AND terminal.`entry_type` IN ('SETTLE','RELEASE')
    )
  ))
BEGIN SELECT RAISE(ABORT, 'invalid credit ledger entry'); END;

--> statement-breakpoint
DROP TRIGGER generation_dead_letter_open;
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
  ) AND NOT EXISTS (
    SELECT 1 FROM generation_moderation_rejections rejection
    WHERE rejection.item_id=NEW.id AND rejection.attempt_id=NEW.current_attempt_id AND rejection.job_id=NEW.job_id AND rejection.owner_id=NEW.owner_id AND rejection.lease_generation=NEW.lease_generation AND rejection.reservation_id=NEW.billing_reservation_id
  );
END;

--> statement-breakpoint
CREATE TRIGGER generation_moderation_rejection_release AFTER INSERT ON generation_moderation_rejections
BEGIN
 UPDATE generation_attempts SET state='FAILED',retry_class='not-retryable',error_code=CASE WHEN NEW.decision='Review' THEN 'CONTENT_REVIEW_REQUIRED' ELSE 'CONTENT_BLOCKED' END,error_message=CASE WHEN NEW.decision='Review' THEN '内容需要进一步确认，请调整后重试。' ELSE '内容未通过检查，请调整后重试。' END,finished_at=unixepoch() WHERE id=NEW.attempt_id;
 UPDATE generation_job_items SET status='FAILED',last_error_code=CASE WHEN NEW.decision='Review' THEN 'CONTENT_REVIEW_REQUIRED' ELSE 'CONTENT_BLOCKED' END,last_error_message=CASE WHEN NEW.decision='Review' THEN '内容需要进一步确认，请调整后重试。' ELSE '内容未通过检查，请调整后重试。' END,last_error_retryable=0,finished_at=unixepoch(),lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=unixepoch() WHERE id=NEW.item_id AND current_attempt_id=NEW.attempt_id AND lease_generation=NEW.lease_generation AND status='PERSISTING';
 UPDATE generation_output_commits SET state='REJECTED',updated_at=unixepoch() WHERE id=NEW.commit_id AND state='OBJECT_STORED';
 UPDATE assets SET moderation_status='REJECTED',moderated_at=CURRENT_TIMESTAMP WHERE id=NEW.asset_id AND status='PENDING';
 INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,reservation_id,job_id,item_id,attempt_id,idempotency_key,reason_code,price_version,actor_id,request_id)
 VALUES('ledger_release_'||NEW.reservation_id,NEW.owner_id,'RELEASE',NEW.amount,NEW.reservation_id,NEW.job_id,NEW.item_id,NEW.attempt_id,'release:'||NEW.reservation_id,'OUTPUT_MODERATION_REJECTED',NEW.price_version,'system',NEW.commit_id);
 SELECT RAISE(ABORT,'moderation rejection did not release reservation') WHERE NOT EXISTS(SELECT 1 FROM generation_job_items item JOIN credit_ledger_entries released ON released.item_id=item.id WHERE item.id=NEW.item_id AND item.current_attempt_id=NEW.attempt_id AND item.lease_generation=NEW.lease_generation AND item.status='FAILED' AND released.entry_type='RELEASE' AND released.reservation_id=NEW.reservation_id AND released.amount=NEW.amount AND released.request_id=NEW.commit_id);
END;
