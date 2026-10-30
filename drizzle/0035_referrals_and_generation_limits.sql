-- Existing referrals keep their benefits if a promoter stops accepting new invitations.
CREATE TABLE referral_promoters (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE user_referrals (
 invitee_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 promoter_id TEXT NOT NULL REFERENCES referral_promoters(user_id) ON DELETE RESTRICT,
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 CHECK(invitee_id <> promoter_id)
);
--> statement-breakpoint
CREATE INDEX idx_referral_promoter ON user_referrals(promoter_id, invitee_id);
--> statement-breakpoint
CREATE TRIGGER referral_no_update BEFORE UPDATE ON user_referrals BEGIN SELECT RAISE(ABORT,'referral immutable'); END;
--> statement-breakpoint
CREATE TRIGGER referral_no_delete BEFORE DELETE ON user_referrals BEGIN SELECT RAISE(ABORT,'referral immutable'); END;
--> statement-breakpoint
CREATE TABLE referral_order_terms (
 order_id TEXT PRIMARY KEY REFERENCES recharge_orders_v2(id) ON DELETE RESTRICT,
 invitee_id TEXT NOT NULL REFERENCES user_referrals(invitee_id) ON DELETE RESTRICT,
 promoter_id TEXT NOT NULL REFERENCES referral_promoters(user_id) ON DELETE RESTRICT,
 rule_version TEXT NOT NULL,
 commission_bps INTEGER NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),
 bonus_bps INTEGER NOT NULL CHECK(bonus_bps BETWEEN 0 AND 10000),
 amount_fen INTEGER NOT NULL CHECK(amount_fen>0),
 bonus_credits INTEGER NOT NULL CHECK(bonus_credits>0),
 commission_fen INTEGER NOT NULL CHECK(commission_fen>=0)
);
--> statement-breakpoint
CREATE TRIGGER referral_terms_guard BEFORE INSERT ON referral_order_terms
WHEN NOT EXISTS(SELECT 1 FROM recharge_orders_v2 o JOIN user_referrals r ON r.invitee_id=o.owner_id
 WHERE o.id=NEW.order_id AND o.status='PENDING' AND r.invitee_id=NEW.invitee_id AND r.promoter_id=NEW.promoter_id
 AND NEW.amount_fen=o.amount_fen AND NEW.bonus_credits=CAST(o.credits*NEW.bonus_bps/10000 AS INTEGER)
 AND NEW.commission_fen=CAST(o.amount_fen*NEW.commission_bps/10000 AS INTEGER))
BEGIN SELECT RAISE(ABORT,'invalid referral terms'); END;
--> statement-breakpoint
CREATE TRIGGER referral_terms_no_update BEFORE UPDATE ON referral_order_terms BEGIN SELECT RAISE(ABORT,'referral terms immutable'); END;
--> statement-breakpoint
CREATE TRIGGER referral_terms_no_delete BEFORE DELETE ON referral_order_terms BEGIN SELECT RAISE(ABORT,'referral terms immutable'); END;
--> statement-breakpoint
CREATE TABLE referral_rewards (
 order_id TEXT PRIMARY KEY REFERENCES referral_order_terms(order_id) ON DELETE RESTRICT,
 created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TRIGGER referral_reward_guard BEFORE INSERT ON referral_rewards
WHEN NOT EXISTS(SELECT 1 FROM recharge_orders_v2 o JOIN referral_order_terms t ON t.order_id=o.id
 JOIN recharge_payment_events_v2 p ON p.order_id=o.id AND p.amount_fen=o.amount_fen
 WHERE o.id=NEW.order_id AND o.status='CREDITED')
BEGIN SELECT RAISE(ABORT,'unpaid referral reward'); END;
--> statement-breakpoint
CREATE TRIGGER referral_reward_no_update BEFORE UPDATE ON referral_rewards BEGIN SELECT RAISE(ABORT,'referral reward immutable'); END;
--> statement-breakpoint
CREATE TRIGGER referral_reward_no_delete BEFORE DELETE ON referral_rewards BEGIN SELECT RAISE(ABORT,'referral reward immutable'); END;
--> statement-breakpoint
CREATE TRIGGER referral_paid AFTER UPDATE OF status ON recharge_orders_v2
WHEN OLD.status='PAID' AND NEW.status='CREDITED' AND EXISTS(SELECT 1 FROM referral_order_terms WHERE order_id=NEW.id)
BEGIN
 INSERT INTO referral_rewards(order_id) VALUES(NEW.id);
 INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,idempotency_key,reason_code,actor_id,request_id)
 SELECT 'ledger_referral_'||order_id,invitee_id,'CREDIT',bonus_credits,'referral-bonus:'||order_id,'REFERRAL_RECHARGE_BONUS','system',order_id FROM referral_order_terms WHERE order_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER referral_bonus_guard BEFORE INSERT ON credit_ledger_entries
WHEN NEW.reason_code='REFERRAL_RECHARGE_BONUS' AND NOT EXISTS(
 SELECT 1 FROM referral_order_terms t JOIN referral_rewards r ON r.order_id=t.order_id
 WHERE NEW.id='ledger_referral_'||t.order_id AND NEW.owner_id=t.invitee_id AND NEW.entry_type='CREDIT'
 AND NEW.amount=t.bonus_credits AND NEW.idempotency_key='referral-bonus:'||t.order_id AND NEW.actor_id='system' AND NEW.request_id=t.order_id)
BEGIN SELECT RAISE(ABORT,'invalid referral bonus'); END;
--> statement-breakpoint
ALTER TABLE auth_oauth_states ADD COLUMN invite_code TEXT;
--> statement-breakpoint
UPDATE user_generation_limits SET active_concurrency_limit=3 WHERE owner_id<>'TEST0001';
