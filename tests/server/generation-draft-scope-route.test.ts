import { LEGAL_VERSION } from "../../lib/domain/legal";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import test from "node:test";
import { createServer } from "vite";
import { hashIdentifier } from "../../lib/server/actor";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";

const bindingKey = Symbol.for("zaoshi.test.cloudflare.bindings");
const model = "doubao-seedream-5-0-pro-260628";

function body(draftScope?: string): Record<string, unknown> {
  return {
    workflowType: "concept", purpose: "final", sourceAssetId: "missing-source", stylePresetId: "modern-minimalist",
    lightingPreset: "morning", preservationMode: "structure", providerPreference: model,
    resolution: "2K", aspectRatio: "4:3", quality: "standard", visualRealism: "photorealistic",
    lampState: "mixed", colorTemperatureKelvin: 4000, outputCount: 1, idempotencyKey: crypto.randomUUID(),
    ...(draftScope === undefined ? {} : { draftScope }),
  };
}

test("jobs reject missing or foreign draft scopes before any queue, quota, or credit write", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const ownerA = `chatgpt:${hashIdentifier("actor-a")}`;
  const ownerB = `chatgpt:${hashIdentifier("actor-b")}`;
  (globalThis as typeof globalThis & { [key: symbol]: unknown })[bindingKey] = {
    DB: new TestD1Database(database), BACKEND_PROFILE: "sites-demo", TRUST_PLATFORM_IDENTITY_HEADERS: "1",
  };
  database.prepare("INSERT INTO users(id,display_name) VALUES (?,?)").run(ownerA, "Synthetic actor");
  for (const document of ["terms", "privacy"]) database.prepare("INSERT INTO user_legal_acceptances(user_id,document,version,accepted_at) VALUES (?,?,?,?)").run(ownerA, document, LEGAL_VERSION, Math.floor(Date.now()/1000));
  const server = await createServer({ configFile: false, logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: { "@": resolve("."), "cloudflare:workers": resolve("tests/helpers/cloudflare-workers.ts") } } });
  try {
    const route = await server.ssrLoadModule("/app/api/jobs/route.ts") as typeof import("../../app/api/jobs/route");
    const request = (value: Record<string, unknown>) => route.POST(new Request("http://localhost/api/jobs", {
      method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json", "oai-authenticated-user-id": "actor-a", "oai-authenticated-user-email": "test@example.com" }, body: JSON.stringify(value),
    }));
    for (const value of [body(), body(hashIdentifier(`draft:${ownerB}`))]) {
      const response = await request(value);
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "DRAFT_SCOPE_MISMATCH");
    }
    for (const table of ["generation_jobs", "generation_job_items", "generation_quota_admissions", "credit_ledger_entries"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0, table);
    }
    const accepted = await request(body(hashIdentifier(`draft:${ownerA}`)));
    assert.equal(accepted.status, 503);
    assert.equal((await accepted.json() as { error: { code: string } }).error.code, "GENERATION_QUEUE_NOT_READY");
    for (const table of ["generation_jobs", "generation_job_items", "generation_quota_admissions", "credit_ledger_entries"]) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0, table);
    }
  } finally {
    await server.close();
  }
});
