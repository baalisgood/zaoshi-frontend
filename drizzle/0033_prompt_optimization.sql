CREATE TABLE prompt_optimization_requests (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 context TEXT NOT NULL CHECK(context IN ('ordinary','local-prompt')),
 model TEXT NOT NULL,
 template_version TEXT NOT NULL,
 price_version TEXT NOT NULL,
 token_cap INTEGER NOT NULL CHECK(token_cap BETWEEN 1 AND 20000),
 cap INTEGER NOT NULL CHECK(cap=MAX(1,(token_cap*240+999999)/1000000)),
 status TEXT NOT NULL DEFAULT 'QUOTED' CHECK(status IN ('QUOTED','DISPATCHING','SUCCEEDED','FAILED')),
 result TEXT,
 input_tokens INTEGER,
 actual INTEGER,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 expires_at INTEGER NOT NULL,
 finished_at INTEGER,
 UNIQUE(owner_id,idempotency_key),
 CHECK((status='SUCCEEDED' AND result IS NOT NULL AND input_tokens IS NOT NULL AND actual IS NOT NULL AND length(result) BETWEEN 1 AND 2000 AND input_tokens BETWEEN 1 AND token_cap AND actual=MAX(1,(input_tokens*240+999999)/1000000) AND actual<=cap AND finished_at IS NOT NULL)
 OR (status<>'SUCCEEDED' AND result IS NULL AND input_tokens IS NULL AND actual IS NULL))
);
--> statement-breakpoint
CREATE TRIGGER prompt_optimization_insert_guard BEFORE INSERT ON prompt_optimization_requests
WHEN NEW.status<>'QUOTED' OR NEW.finished_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'optimization must begin with a quote'); END;
--> statement-breakpoint
CREATE INDEX idx_prompt_optimization_owner_created ON prompt_optimization_requests(owner_id,created_at);
--> statement-breakpoint
ALTER TABLE credit_ledger_entries ADD COLUMN optimization_id TEXT REFERENCES prompt_optimization_requests(id) ON DELETE RESTRICT;
--> statement-breakpoint
DROP TRIGGER credit_ledger_insert_guard;
--> statement-breakpoint
CREATE TRIGGER credit_ledger_insert_guard BEFORE INSERT ON credit_ledger_entries
WHEN (NEW.optimization_id IS NULL AND (
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
)) OR (NEW.optimization_id IS NOT NULL AND (
 NEW.entry_type='CREDIT' OR NEW.job_id IS NOT NULL OR NEW.item_id IS NOT NULL OR NEW.attempt_id IS NOT NULL
 OR NEW.reservation_id IS NOT NEW.optimization_id
 OR NEW.id IS NOT ('opt_'||NEW.entry_type||'_'||NEW.optimization_id)
 OR NEW.idempotency_key IS NOT ('opt:'||NEW.entry_type||':'||NEW.optimization_id)
 OR NEW.actor_id IS NOT 'system' OR NEW.request_id IS NOT NEW.optimization_id
 OR NEW.reason_code IS NOT 'PROMPT_OPTIMIZATION'
 OR NOT EXISTS (SELECT 1 FROM prompt_optimization_requests p WHERE p.id=NEW.optimization_id AND p.owner_id=NEW.owner_id AND p.price_version=NEW.price_version AND (
   (NEW.entry_type='RESERVE' AND p.status='DISPATCHING' AND NEW.amount=p.cap)
   OR (NEW.entry_type='SETTLE' AND p.status='SUCCEEDED' AND NEW.amount=p.actual AND EXISTS(SELECT 1 FROM credit_ledger_entries r WHERE r.reservation_id=p.id AND r.entry_type='RESERVE' AND r.optimization_id=p.id AND r.amount=p.cap))
   OR (NEW.entry_type='RELEASE' AND NEW.amount=CASE WHEN p.status='SUCCEEDED' THEN p.cap-p.actual WHEN p.status='FAILED' THEN p.cap ELSE 0 END AND EXISTS(SELECT 1 FROM credit_ledger_entries r WHERE r.reservation_id=p.id AND r.entry_type='RESERVE' AND r.optimization_id=p.id AND r.amount=p.cap) AND (p.status='FAILED' OR EXISTS(SELECT 1 FROM credit_ledger_entries t WHERE t.optimization_id=p.id AND t.entry_type='SETTLE' AND t.amount=p.actual)))
 ))
)) BEGIN SELECT RAISE(ABORT,'invalid credit ledger entry'); END;
--> statement-breakpoint
CREATE TRIGGER prompt_optimization_update_guard BEFORE UPDATE ON prompt_optimization_requests
WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.idempotency_key IS NOT OLD.idempotency_key
 OR NEW.request_hash IS NOT OLD.request_hash OR NEW.context IS NOT OLD.context OR NEW.model IS NOT OLD.model
 OR NEW.template_version IS NOT OLD.template_version OR NEW.price_version IS NOT OLD.price_version
 OR NEW.cap IS NOT OLD.cap OR NEW.token_cap IS NOT OLD.token_cap OR NEW.created_at IS NOT OLD.created_at
 OR NOT ((OLD.status='QUOTED' AND NEW.status='DISPATCHING' AND OLD.expires_at>unixepoch() AND NEW.expires_at BETWEEN unixepoch()+1 AND unixepoch()+60)
      OR (OLD.status='DISPATCHING' AND NEW.status='SUCCEEDED' AND OLD.expires_at>unixepoch() AND NEW.expires_at=OLD.expires_at)
      OR (OLD.status IN ('QUOTED','DISPATCHING') AND NEW.status='FAILED' AND NEW.expires_at=OLD.expires_at))
BEGIN SELECT RAISE(ABORT,'invalid optimization transition'); END;
--> statement-breakpoint
CREATE TRIGGER prompt_optimization_no_delete BEFORE DELETE ON prompt_optimization_requests BEGIN SELECT RAISE(ABORT,'optimization history is preserved'); END;
--> statement-breakpoint
CREATE TRIGGER prompt_optimization_reserve AFTER UPDATE OF status ON prompt_optimization_requests WHEN NEW.status='DISPATCHING'
BEGIN
 SELECT RAISE(ABORT,'optimization account unavailable') WHERE NOT EXISTS(SELECT 1 FROM users u LEFT JOIN user_generation_limits l ON l.owner_id=u.id WHERE u.id=NEW.owner_id AND u.status='ACTIVE' AND COALESCE(l.enabled,1)=1);
 SELECT RAISE(ABORT,'optimization busy') WHERE EXISTS(SELECT 1 FROM prompt_optimization_requests p WHERE p.owner_id=NEW.owner_id AND p.id<>NEW.id AND p.status='DISPATCHING');
 INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,reservation_id,optimization_id,idempotency_key,reason_code,price_version,actor_id,request_id)
 VALUES('opt_RESERVE_'||NEW.id,NEW.owner_id,'RESERVE',NEW.cap,NEW.id,NEW.id,'opt:RESERVE:'||NEW.id,'PROMPT_OPTIMIZATION',NEW.price_version,'system',NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER prompt_optimization_finish AFTER UPDATE OF status ON prompt_optimization_requests WHEN NEW.status IN ('SUCCEEDED','FAILED') AND OLD.status='DISPATCHING'
BEGIN
 INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,reservation_id,optimization_id,idempotency_key,reason_code,price_version,actor_id,request_id)
 SELECT 'opt_SETTLE_'||NEW.id,NEW.owner_id,'SETTLE',NEW.actual,NEW.id,NEW.id,'opt:SETTLE:'||NEW.id,'PROMPT_OPTIMIZATION',NEW.price_version,'system',NEW.id WHERE NEW.status='SUCCEEDED';
 INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,reservation_id,optimization_id,idempotency_key,reason_code,price_version,actor_id,request_id)
 SELECT 'opt_RELEASE_'||NEW.id,NEW.owner_id,'RELEASE',CASE WHEN NEW.status='SUCCEEDED' THEN NEW.cap-NEW.actual ELSE NEW.cap END,NEW.id,NEW.id,'opt:RELEASE:'||NEW.id,'PROMPT_OPTIMIZATION',NEW.price_version,'system',NEW.id WHERE NEW.status='FAILED' OR NEW.cap>NEW.actual;
END;
