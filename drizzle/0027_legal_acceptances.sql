CREATE TABLE user_legal_acceptances (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 document TEXT NOT NULL CHECK(document IN ('terms','privacy')),
 version TEXT NOT NULL,
 accepted_at INTEGER NOT NULL,
 PRIMARY KEY(user_id, document, version)
);
