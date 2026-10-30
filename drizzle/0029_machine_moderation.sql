CREATE TABLE asset_moderation_evidence (
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
 policy_version TEXT NOT NULL, request_id TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('Pass','Review','Block')),
 checked_at INTEGER NOT NULL DEFAULT(unixepoch()),
 PRIMARY KEY(asset_id,content_sha256,policy_version)
);

--> statement-breakpoint
CREATE TABLE text_moderation_evidence (
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
 policy_version TEXT NOT NULL, request_id TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('Pass','Review','Block')),
 checked_at INTEGER NOT NULL DEFAULT(unixepoch()),
 PRIMARY KEY(owner_id,content_sha256,policy_version)
);
