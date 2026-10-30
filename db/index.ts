import { drizzle } from "drizzle-orm/d1";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import * as schema from "./schema";

let initializedDatabase: D1Database | null = null;
let initializingDatabase: D1Database | null = null;
let initializationPromise: Promise<void> | null = null;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'READY',
    original_file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    sanitization_version TEXT,
    storage_key TEXT NOT NULL UNIQUE,
    parent_asset_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    retention_expires_at INTEGER,
    deletion_requested_at INTEGER,
    deletion_action_id TEXT,
    purged_at INTEGER,
    moderation_status TEXT NOT NULL DEFAULT 'UNREVIEWED',
    moderated_at INTEGER,
    moderation_reason TEXT,
    moderation_action_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assets_owner_created
    ON assets(owner_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_owner_kind
    ON assets(owner_id, kind)`,
  `CREATE TABLE IF NOT EXISTS generation_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    source_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
    reference_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
    additional_references_json TEXT NOT NULL DEFAULT '[]',
    mask_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
    depth_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
    normal_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
    workflow_type TEXT NOT NULL DEFAULT 'concept',
    purpose TEXT NOT NULL DEFAULT 'final',
    source_job_id TEXT,
    promoted_from_asset_id TEXT,
    resolution TEXT NOT NULL DEFAULT '1K',
    effective_resolution TEXT NOT NULL DEFAULT '1K',
    aspect_ratio TEXT NOT NULL DEFAULT '4:3',
    quality TEXT NOT NULL DEFAULT 'standard',
    visual_realism TEXT NOT NULL DEFAULT 'photorealistic',
    lamp_state TEXT NOT NULL DEFAULT 'mixed',
    color_temperature_kelvin INTEGER NOT NULL DEFAULT 4000,
    space_type TEXT NOT NULL DEFAULT 'unspecified',
    style_preset_id TEXT NOT NULL,
    design_scheme_id TEXT,
    lighting_preset TEXT NOT NULL,
    preservation_mode TEXT NOT NULL,
    provider_preference TEXT NOT NULL,
    edit_instruction TEXT,
    custom_prompt TEXT,
    output_count INTEGER NOT NULL,
    advanced_settings_json TEXT NOT NULL DEFAULT '{"version":1,"geometryFidelity":"balanced","cameraPolicy":"locked","furnishingDensity":"balanced","materialExpression":"natural","lightingContrast":"balanced"}',
    status TEXT NOT NULL DEFAULT 'QUEUED',
    completed_output_count INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    provider_request_id TEXT,
    prompt_template_version TEXT,
    error_code TEXT,
    error_message TEXT,
    error_retryable INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    finished_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_generation_jobs_owner_idempotency
    ON generation_jobs(owner_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_generation_jobs_owner_created
    ON generation_jobs(owner_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_updated
    ON generation_jobs(status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS generation_job_outputs (
    job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_generation_job_outputs_job_ordinal
    ON generation_job_outputs(job_id, ordinal)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_generation_job_outputs_asset
    ON generation_job_outputs(asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_generation_job_outputs_job
    ON generation_job_outputs(job_id)`,
  `CREATE TABLE IF NOT EXISTS studio_templates (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, workflow_type TEXT NOT NULL, name TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_studio_templates_owner ON studio_templates(owner_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS template_shares (id TEXT PRIMARY KEY NOT NULL, template_id TEXT NOT NULL REFERENCES studio_templates(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_template_shares_template ON template_shares(template_id)`,
  `CREATE TABLE IF NOT EXISTS gallery_items (id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, source_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT, category TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', public_prompt TEXT, consent_version TEXT NOT NULL, image_consent_at TEXT NOT NULL, prompt_consent_at TEXT, thumb_key TEXT NOT NULL, display_key TEXT NOT NULL, thumb_mime TEXT NOT NULL DEFAULT 'image/webp', display_mime TEXT NOT NULL DEFAULT 'image/webp', thumb_bytes INTEGER NOT NULL, display_bytes INTEGER NOT NULL, thumb_sha256 TEXT NOT NULL, display_sha256 TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', submitted_at TEXT NOT NULL, reviewed_at TEXT, published_at TEXT, rejected_at TEXT, revoked_at TEXT, updated_at TEXT NOT NULL, reviewer_owner_id TEXT, review_note TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_gallery_public_feed ON gallery_items(status, published_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_gallery_public_category_feed ON gallery_items(status, category, published_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_gallery_owner_submissions ON gallery_items(owner_id, submitted_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_gallery_active_source ON gallery_items(source_asset_id) WHERE status IN ('PENDING', 'APPROVED')`,
] as const;

const generationJobColumnMigrations = [
  { name: "additional_references_json", sql: "ALTER TABLE generation_jobs ADD COLUMN additional_references_json TEXT NOT NULL DEFAULT '[]'" },
  {
    name: "depth_asset_id",
    sql: "ALTER TABLE generation_jobs ADD COLUMN depth_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT",
  },
  {
    name: "normal_asset_id",
    sql: "ALTER TABLE generation_jobs ADD COLUMN normal_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT",
  },
  {
    name: "workflow_type",
    sql: "ALTER TABLE generation_jobs ADD COLUMN workflow_type TEXT NOT NULL DEFAULT 'concept'",
  },
  { name: "purpose", sql: "ALTER TABLE generation_jobs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'final'" },
  { name: "source_job_id", sql: "ALTER TABLE generation_jobs ADD COLUMN source_job_id TEXT" },
  { name: "promoted_from_asset_id", sql: "ALTER TABLE generation_jobs ADD COLUMN promoted_from_asset_id TEXT" },
  {
    name: "resolution",
    sql: "ALTER TABLE generation_jobs ADD COLUMN resolution TEXT NOT NULL DEFAULT '1K'",
  },
  { name: "effective_resolution", sql: "ALTER TABLE generation_jobs ADD COLUMN effective_resolution TEXT NOT NULL DEFAULT '1K'" },
  {
    name: "aspect_ratio",
    sql: "ALTER TABLE generation_jobs ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT '4:3'",
  },
  {
    name: "quality",
    sql: "ALTER TABLE generation_jobs ADD COLUMN quality TEXT NOT NULL DEFAULT 'standard'",
  },
  {
    name: "visual_realism",
    sql: "ALTER TABLE generation_jobs ADD COLUMN visual_realism TEXT NOT NULL DEFAULT 'photorealistic'",
  },
  {
    name: "lamp_state",
    sql: "ALTER TABLE generation_jobs ADD COLUMN lamp_state TEXT NOT NULL DEFAULT 'mixed'",
  },
  {
    name: "color_temperature_kelvin",
    sql: "ALTER TABLE generation_jobs ADD COLUMN color_temperature_kelvin INTEGER NOT NULL DEFAULT 4000",
  },
  { name: "space_type", sql: "ALTER TABLE generation_jobs ADD COLUMN space_type TEXT NOT NULL DEFAULT 'unspecified'" },
  { name: "design_scheme_id", sql: "ALTER TABLE generation_jobs ADD COLUMN design_scheme_id TEXT" },
  {
    name: "advanced_settings_json",
    sql: "ALTER TABLE generation_jobs ADD COLUMN advanced_settings_json TEXT NOT NULL DEFAULT '{\"version\":1,\"geometryFidelity\":\"balanced\",\"cameraPolicy\":\"locked\",\"furnishingDensity\":\"balanced\",\"materialExpression\":\"natural\",\"lightingContrast\":\"balanced\"}'",
  },
  {
    name: "custom_prompt",
    sql: "ALTER TABLE generation_jobs ADD COLUMN custom_prompt TEXT",
  },
] as const;

function bindings(): Record<string, unknown> {
  return readRuntimeBindings();
}

export function getD1Binding(): D1Database | null {
  return (bindings().DB as D1Database | undefined) ?? null;
}

export function getR2Binding(): R2Bucket | null {
  return (bindings().ASSETS_BUCKET as R2Bucket | undefined) ?? null;
}

export function getDb() {
  const d1 = getD1Binding();
  if (!d1) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Production does not fall back to memory.",
    );
  }

  return drizzle(d1, { schema });
}

export async function ensureDatabase(): Promise<void> {
  const d1 = getD1Binding();
  if (!d1 || initializedDatabase === d1) return;

  if (initializingDatabase === d1 && initializationPromise) {
    return initializationPromise;
  }

  initializingDatabase = d1;
  const currentInitialization = initializeDatabase(d1);
  initializationPromise = currentInitialization;
  try {
    await currentInitialization;
    initializedDatabase = d1;
  } finally {
    if (initializationPromise === currentInitialization) {
      initializingDatabase = null;
      initializationPromise = null;
    }
  }
}

async function initializeDatabase(d1: D1Database): Promise<void> {
  await d1.batch(schemaStatements.map((statement) => d1.prepare(statement)));
  const columnInfo = await d1
    .prepare("PRAGMA table_info(generation_jobs)")
    .all<{ name: string }>();
  const existingColumns = new Set(
    (columnInfo.results ?? []).map((column) => column.name),
  );
  for (const migration of generationJobColumnMigrations) {
    if (!existingColumns.has(migration.name)) {
      await d1.prepare(migration.sql).run();
    }
  }
  await d1.prepare("UPDATE generation_jobs SET effective_resolution = resolution WHERE purpose = 'final' AND effective_resolution = '1K' AND resolution <> '1K'").run();
  await d1.prepare("CREATE INDEX IF NOT EXISTS idx_generation_jobs_source_job ON generation_jobs(source_job_id)").run();
  await d1.prepare("CREATE INDEX IF NOT EXISTS idx_generation_jobs_owner_workflow_created ON generation_jobs(owner_id, workflow_type, created_at, id)").run();
  await d1.prepare("PRAGMA optimize").run();
}
