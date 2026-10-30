ALTER TABLE auth_oauth_states ADD COLUMN intent TEXT NOT NULL DEFAULT 'login' CHECK(intent IN ('login','bind'));
ALTER TABLE auth_oauth_states ADD COLUMN target_owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE auth_oauth_states ADD COLUMN initiating_session_hash TEXT;
ALTER TABLE users ADD COLUMN wechat_registration_receipt TEXT;
