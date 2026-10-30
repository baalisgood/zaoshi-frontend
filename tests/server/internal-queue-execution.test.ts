import { DisabledModeration } from "../../lib/server/machine-moderation";
import { testModeration } from "../helpers/test-moderation";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { D1GenerationQueue } from "../../lib/server/generation-queue";
import { InternalQueueExecutionService } from "../../lib/server/internal-queue-execution";
import { InternalQueueService } from "../../lib/server/internal-queue-service";
import { createInputTicket } from "../../lib/server/internal-queue-ticket";
import { applyMigrations, creditTestOwner, TEST_GENERATION_BILLING, TestD1Database } from "../helpers/test-d1";
import { TestR2Bucket } from "../helpers/test-r2";

const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const TICKET_CONFIG = {
  audience: "zaoshi-queue-test",
  secret: "queue-ticket-secret-that-is-at-least-thirty-two-bytes",
  ttlSeconds: 240,
};
const OPTIONS = {
  leaseSeconds: 180,
  ownerConcurrency: 1,
  providerConcurrency: 1,
  sweepLimit: 50,
};

test("work spec preserves ordered input roles and forces one output per item", async () => {
  const context = await setupJob("job-work");
  const claim = await beginPreprocessing(context.queueService, "work");
  const work = await context.execution.createWork(claim.fence);

  assert.equal(work.outputCount, 1);
  assert.equal(work.outputOrdinal, 0);
  assert.equal(work.totalOutputs, 1);
  assert.equal(work.providerPreference, "doubao-seedream-4-5-251128");
  assert.deepEqual(
    work.inputs.map((input) => input.role),
    ["source", "style", "furnishing", "depth", "normal"],
  );
  assert.doesNotMatch(JSON.stringify(work), /owner-work|generated\/queue|storage_key/u);

  const first = await context.execution.readInput(
    claim.fence,
    work.inputs[0]!.ticket,
  );
  assert.deepEqual(first.bytes, PNG_BYTES);
  await assert.rejects(
    context.execution.readInput(
      { ...claim.fence, leaseGeneration: claim.fence.leaseGeneration + 1 },
      work.inputs[0]!.ticket,
    ),
    hasCode("INTERNAL_TICKET_INVALID"),
  );
});

test("input tickets cannot select another asset owned by the same user", async () => {
  const context = await setupJob("job-input-scope");
  const claim = await beginPreprocessing(context.queueService, "input-scope");
  const foreignAssetId = "foreign-source-job-input-scope";
  const storageKey = `uploads/${context.ownerId}/${foreignAssetId}.png`;
  context.database
    .prepare(
      `INSERT INTO assets
        (id, owner_id, kind, status, original_file_name, mime_type,
         byte_size, sha256, storage_key, created_at)
       VALUES (?, ?, 'source', 'READY', 'foreign.png', 'image/png', ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .run(
      foreignAssetId,
      context.ownerId,
      PNG_BYTES.byteLength,
      digest(PNG_BYTES),
      storageKey,
    );
  await context.bucket.put(storageKey, PNG_BYTES, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: {
      assetId: foreignAssetId,
      sha256: digest(PNG_BYTES),
      kind: "source",
    },
  });
  const snapshot = await context.queue.inspectFence(claim.fence);
  assert.ok(snapshot?.currentAttemptId && snapshot.leaseExpiresAt);
  const forgedForSameOwner = await createInputTicket({
    config: TICKET_CONFIG,
    fence: claim.fence,
    attemptId: snapshot.currentAttemptId,
    assetId: foreignAssetId,
    role: "source",
    index: 0,
    mimeType: "image/png",
    byteSize: PNG_BYTES.byteLength,
    sha256: digest(PNG_BYTES),
    leaseExpiresAt: snapshot.leaseExpiresAt,
  });
  await assert.rejects(
    context.execution.readInput(claim.fence, forgedForSameOwner),
    hasCode("QUEUE_INPUT_CONFLICT"),
  );
});

test("ordinary concept jobs cannot execute from an output asset", async () => {
  const context = await setupJob("job-concept-output");
  context.database
    .prepare(
      `UPDATE generation_jobs
       SET workflow_type = 'concept', additional_references_json = '[]',
           depth_asset_id = NULL, normal_asset_id = NULL
       WHERE id = ?`,
    )
    .run("job-concept-output");
  context.database
    .prepare("UPDATE assets SET kind = 'output' WHERE id = ?")
    .run("source-job-concept-output");
  const claim = await beginPreprocessing(context.queueService, "concept-output");
  await assert.rejects(
    context.execution.createWork(claim.fence),
    hasCode("QUEUE_INPUT_NOT_READY"),
  );
});

test("fenced output commit publishes exactly one result and replays safely", async () => {
  const context = await setupJob("job-output");
  const claim = await beginPreprocessing(context.queueService, "output");
  await beginPersisting(context.queueService, claim.fence, "provider-output-1");
  const declaration = {
    fence: claim.fence,
    uploadRequestId: "upload-output-1",
    providerRequestId: "provider-output-1",
    promptTemplateVersion: "interior-concept-v4",
    sanitizationVersion: "canonical-image-v1",
    mimeType: "image/png",
    byteSize: PNG_BYTES.byteLength,
    sha256: digest(PNG_BYTES),
  };
  await assert.rejects(
    context.execution.prepareOutput({
      ...declaration,
      sanitizationVersion: null,
    }),
    hasCode("OUTPUT_SANITIZATION_UNPROVEN"),
  );
  const prepared = await context.execution.prepareOutput(declaration);
  assert.equal(prepared.result, "prepared");
  assert.ok(prepared.ticket);

  const uploaded = await context.execution.uploadOutput(
    claim.fence,
    prepared.ticket,
    PNG_BYTES,
    "image/png",
  );
  assert.equal(uploaded.result, "applied");
  assert.equal(
    (
      await context.execution.uploadOutput(
        claim.fence,
        prepared.ticket,
        PNG_BYTES,
        "image/png",
      )
    ).result,
    "already_applied",
  );
  assert.equal(
    context.database
      .prepare("SELECT COUNT(*) AS count FROM generation_job_outputs WHERE job_id = ?")
      .get("job-output")?.count,
    1,
  );
  assert.deepEqual(await context.execution.prepareOutput(declaration), {
    result: "already_committed",
    commitId: prepared.commitId,
    ticket: null,
  });
  assert.deepEqual(
    context.database
      .prepare(
        `SELECT item.status AS itemStatus, attempt.state AS attemptState,
                oc.state AS commitState, job.status AS jobStatus,
                asset.status AS assetStatus
         FROM generation_job_items AS item
         JOIN generation_attempts AS attempt ON attempt.id = item.current_attempt_id
         JOIN generation_output_commits AS oc ON oc.item_id = item.id
         JOIN generation_jobs AS job ON job.id = item.job_id
         JOIN assets AS asset ON asset.id = oc.asset_id
         WHERE item.job_id = ?`,
      )
      .get("job-output"),
    nullPrototype({
      itemStatus: "SUCCEEDED",
      attemptState: "SUCCEEDED",
      commitState: "COMMITTED",
      jobStatus: "SUCCEEDED",
      assetStatus: "READY",
    }),
  );
});

test("a different output digest or an expired fence cannot replace a reservation", async () => {
  const context = await setupJob("job-conflict");
  const claim = await beginPreprocessing(context.queueService, "conflict");
  await beginPersisting(context.queueService, claim.fence, null);
  const declaration = {
    fence: claim.fence,
    uploadRequestId: "upload-conflict-1",
    providerRequestId: null,
    promptTemplateVersion: "interior-concept-v4",
    sanitizationVersion: "canonical-image-v1",
    mimeType: "image/png",
    byteSize: PNG_BYTES.byteLength,
    sha256: digest(PNG_BYTES),
  };
  await context.execution.prepareOutput(declaration);
  await assert.rejects(
    context.execution.prepareOutput({
      ...declaration,
      uploadRequestId: "upload-conflict-2",
      sha256: "f".repeat(64),
    }),
    hasCode("OUTPUT_COMMIT_CONFLICT"),
  );

  context.database
    .prepare(
      "UPDATE generation_job_items SET lease_expires_at = unixepoch() - 1 WHERE job_id = ?",
    )
    .run("job-conflict");
  await assert.rejects(
    context.execution.prepareOutput(declaration),
    hasCode("QUEUE_FENCE_STALE"),
  );
});

test("an R2 write survives a failed D1 finalize and the sweeper commits it once", async () => {
  let failFinalize = false;
  const context = await setupJob("job-recover", (statement) => {
    if (
      failFinalize &&
      statement.sqlText().includes("UPDATE generation_job_items") &&
      statement.sqlText().includes("status = 'SUCCEEDED'")
    ) {
      failFinalize = false;
      throw new Error("simulated D1 finalize crash");
    }
  });
  const claim = await beginPreprocessing(context.queueService, "recover");
  await beginPersisting(context.queueService, claim.fence, "provider-recover-1");
  const prepared = await context.execution.prepareOutput({
    fence: claim.fence,
    uploadRequestId: "upload-recover-1",
    providerRequestId: "provider-recover-1",
    promptTemplateVersion: "interior-concept-v4",
    sanitizationVersion: "canonical-image-v1",
    mimeType: "image/png",
    byteSize: PNG_BYTES.byteLength,
    sha256: digest(PNG_BYTES),
  });
  assert.ok(prepared.ticket);
  failFinalize = true;
  await assert.rejects(
    context.execution.uploadOutput(
      claim.fence,
      prepared.ticket,
      PNG_BYTES,
      "image/png",
    ),
    /simulated D1 finalize crash/u,
  );
  assert.equal(
    context.database
      .prepare("SELECT state FROM generation_output_commits WHERE id = ?")
      .get(prepared.commitId)?.state,
    "OBJECT_STORED",
  );
  assert.deepEqual(await context.execution.recoverStoredOutputs(10), {
    recovered: 1,
    reconciliationRequired: 0,
  });
  assert.equal(
    context.database
      .prepare("SELECT status FROM generation_jobs WHERE id = ?")
      .get("job-recover")?.status,
    "SUCCEEDED",
  );
  assert.equal(
    context.database
      .prepare("SELECT COUNT(*) AS count FROM generation_job_outputs WHERE job_id = ?")
      .get("job-recover")?.count,
    1,
  );
});

test("legacy provider output commits without sanitation proof enter reconciliation", async () => {
  const context = await setupJob("job-legacy-output");
  const claim = await beginPreprocessing(context.queueService, "legacy-output");
  await beginPersisting(
    context.queueService,
    claim.fence,
    "provider-legacy-output-1",
  );
  const assetId = "asset-legacy-output";
  const commitId = "commit-legacy-output";
  const storageKey = "generated/legacy-output.png";
  context.database
    .prepare(
      `INSERT INTO assets
        (id, owner_id, kind, status, original_file_name, mime_type,
         byte_size, sha256, storage_key, created_at)
       VALUES (?, ?, 'output', 'PENDING', 'legacy.png', 'image/png', ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .run(
      assetId,
      context.ownerId,
      PNG_BYTES.byteLength,
      digest(PNG_BYTES),
      storageKey,
    );
  context.database
    .prepare(
      `INSERT INTO generation_output_commits
        (id, item_id, attempt_id, lease_generation, upload_request_id,
         asset_id, storage_key, provider_request_id, prompt_template_version,
         mime_type, byte_size, sha256)
       VALUES (?, ?, ?, ?, 'upload-legacy-output', ?, ?,
               'provider-legacy-output-1', 'interior-concept-v4',
               'image/png', ?, ?)`,
    )
    .run(
      commitId,
      claim.fence.itemId,
      claim.attemptId,
      claim.fence.leaseGeneration,
      assetId,
      storageKey,
      PNG_BYTES.byteLength,
      digest(PNG_BYTES),
    );
  await context.bucket.put(storageKey, PNG_BYTES, {
    httpMetadata: { contentType: "image/png" },
  });

  assert.deepEqual(await context.execution.recoverStoredOutputs(10), {
    recovered: 0,
    reconciliationRequired: 1,
  });
  assert.deepEqual(
    context.database
      .prepare(
        `SELECT item.status AS itemStatus, attempt.state AS attemptState,
                commit_record.state AS commitState, asset.status AS assetStatus
         FROM generation_job_items AS item
         JOIN generation_attempts AS attempt ON attempt.id = item.current_attempt_id
         JOIN generation_output_commits AS commit_record ON commit_record.item_id = item.id
         JOIN assets AS asset ON asset.id = commit_record.asset_id
         WHERE item.id = ?`,
      )
      .get(claim.fence.itemId),
    nullPrototype({
      itemStatus: "RECONCILIATION_REQUIRED",
      attemptState: "AMBIGUOUS",
      commitState: "RECONCILIATION_REQUIRED",
      assetStatus: "PENDING",
    }),
  );
});

async function setupJob(
  jobId: string,
  beforeBatchStatement?: ConstructorParameters<typeof TestD1Database>[1],
  moderationControl: {decision:"Pass"|"Review"|"Block"|"unknown"} = {decision:"Pass"},
  outputCount = 1,
) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  const d1 = new TestD1Database(database, beforeBatchStatement);
  const bucket = new TestR2Bucket();
  const queue = new D1GenerationQueue(d1);
  const queueService = new InternalQueueService(queue, OPTIONS);
  const execution = new InternalQueueExecutionService(
    d1,
    bucket,
    TICKET_CONFIG,
    queue, false, null, testModeration(d1,moderationControl),
  );
  const ownerId = `owner-${jobId}`;
  database.prepare("INSERT INTO users(id,display_name) VALUES(?,?)").run(ownerId,ownerId);
  creditTestOwner(database, ownerId);
  const assets = [
    [`source-${jobId}`, "source"],
    [`style-${jobId}`, "reference"],
    [`furnishing-${jobId}`, "reference"],
    [`depth-${jobId}`, "depth"],
    [`normal-${jobId}`, "normal"],
  ] as const;
  for (const [id, kind] of assets) {
    const storageKey = `uploads/${ownerId}/${id}.png`;
    database
      .prepare(
        `INSERT INTO assets
          (id, owner_id, kind, status, original_file_name, mime_type,
           byte_size, sha256, sanitization_version, storage_key, created_at, moderation_status)
         VALUES (?, ?, ?, 'READY', ?, 'image/png', ?, ?, 'canonical-image-v1', ?, CURRENT_TIMESTAMP, 'APPROVED')`,
      )
      .run(
        id,
        ownerId,
        kind,
        `${id}.png`,
        PNG_BYTES.byteLength,
        digest(PNG_BYTES),
        storageKey,
      );
    await bucket.put(storageKey, PNG_BYTES, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { assetId: id, sha256: digest(PNG_BYTES), kind },
    });
  }
  database
    .prepare(
      `INSERT INTO generation_jobs
        (id, owner_id, source_asset_id, reference_asset_id,
         additional_references_json, depth_asset_id, normal_asset_id,
         workflow_type, purpose, resolution, effective_resolution, aspect_ratio,
         quality, visual_realism, lamp_state, color_temperature_kelvin,
         style_preset_id, lighting_preset, preservation_mode,
         provider_preference, output_count, advanced_settings_json,
         idempotency_key, request_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'advanced', 'final', '2K', '2K', '4:3',
               'standard', 'photorealistic', 'mixed', 4000,
               'modern-minimalist', 'noon', 'structure',
               'doubao-seedream-4-5-251128', ${outputCount}, ?, ?, ?)`,
    )
    .run(
      jobId,
      ownerId,
      `source-${jobId}`,
      `style-${jobId}`,
      JSON.stringify([{ assetId: `furnishing-${jobId}`, role: "furnishing" }]),
      `depth-${jobId}`,
      `normal-${jobId}`,
      JSON.stringify({
        version: 1,
        geometryFidelity: "balanced",
        cameraPolicy: "locked",
        furnishingDensity: "balanced",
        materialExpression: "natural",
        lightingContrast: "balanced",
      }),
      `idem-${jobId}`,
      `hash-${jobId}`,
    );
  await queue.materializeItems(jobId, TEST_GENERATION_BILLING);
  return { database, d1, bucket, queue, queueService, execution, ownerId };
}

async function beginPreprocessing(
  service: InternalQueueService,
  suffix: string,
) {
  const claim = await service.claim(`worker-${suffix}`, `claim-${suffix}`);
  assert.ok(claim);
  assert.equal(
    (
      await service.transition({
        fence: claim.fence,
        event: "BEGIN_PREPROCESSING",
      })
    ).result,
    "applied",
  );
  return claim;
}

async function beginPersisting(
  service: InternalQueueService,
  fence: Parameters<InternalQueueService["heartbeat"]>[0],
  providerRequestId: string | null,
) {
  assert.equal(
    (await service.transition({ fence, event: "BEGIN_PROVIDER_DISPATCH", providerAccountSlot: "seedream-primary" })).result,
    "applied",
  );
  assert.equal(
    (
      await service.transition({
        fence,
        event: "RECORD_PROVIDER_RESPONSE",
        providerRequestId,
      })
    ).result,
    "applied",
  );
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}

function nullPrototype<T extends Record<string, unknown>>(value: T): T {
  return Object.assign(Object.create(null), value) as T;
}

async function prepareAuditedOutput(context:Awaited<ReturnType<typeof setupJob>>,name:string){
 const claim=await beginPreprocessing(context.queueService,name);await beginPersisting(context.queueService,claim.fence,`provider-${name}`);
 const prepared=await context.execution.prepareOutput({fence:claim.fence,uploadRequestId:`upload-${name}`,providerRequestId:`provider-${name}`,promptTemplateVersion:"test",sanitizationVersion:"canonical-image-v1",mimeType:"image/png",byteSize:PNG_BYTES.byteLength,sha256:digest(PNG_BYTES)});assert.ok(prepared.ticket);return {claim,prepared};
}
test("machine rejection refunds only rejected item and preserves successful item/provider facts",async()=>{
 const control:{decision:"Pass"|"Review"|"Block"|"unknown"}={decision:"Block"};const context=await setupJob("job-moderation-partial",undefined,control,2);
 const first=await prepareAuditedOutput(context,"moderation-block");const rejected=await context.execution.uploadOutput(first.claim.fence,first.prepared.ticket!,PNG_BYTES,"image/png");assert.equal(rejected.result,"rejected");
 assert.equal(context.database.prepare("SELECT provider_started_at IS NOT NULL AS started,provider_request_id FROM generation_attempts WHERE id=?").get(first.claim.attemptId)?.started,1);
 assert.equal(context.database.prepare("SELECT COUNT(*) n FROM generation_dead_letter_entries").get()?.n,0);
 const replay=await context.execution.prepareOutput({fence:first.claim.fence,uploadRequestId:"upload-moderation-block",providerRequestId:"provider-moderation-block",promptTemplateVersion:"test",sanitizationVersion:"canonical-image-v1",mimeType:"image/png",byteSize:PNG_BYTES.byteLength,sha256:digest(PNG_BYTES)});assert.equal(replay.result,"rejected");
 control.decision="Pass";const second=await prepareAuditedOutput(context,"moderation-pass");assert.equal((await context.execution.uploadOutput(second.claim.fence,second.prepared.ticket!,PNG_BYTES,"image/png")).result,"applied");
 assert.equal(context.database.prepare("SELECT status FROM generation_jobs").get()?.status,"PARTIAL_SUCCEEDED");
 assert.deepEqual(context.database.prepare("SELECT entry_type,COUNT(*) n FROM credit_ledger_entries WHERE entry_type IN ('SETTLE','RELEASE') GROUP BY entry_type ORDER BY entry_type").all().map(r=>({...r})),[{entry_type:"RELEASE",n:1},{entry_type:"SETTLE",n:1}]);
 assert.equal(context.database.prepare("SELECT COUNT(*) n FROM generation_job_outputs").get()?.n,1);assert.equal(context.database.prepare("SELECT status FROM assets WHERE id=?").get(rejected.assetId)?.status,"PENDING");assert.deepEqual(context.database.prepare("PRAGMA foreign_key_check").all(),[]);
});
test("unknown moderation retains stored object across lease expiry and recovers without provider redispatch",async()=>{
 const control:{decision:"Pass"|"Review"|"Block"|"unknown"}={decision:"unknown"};const context=await setupJob("job-moderation-pending",undefined,control);
 const {claim,prepared}=await prepareAuditedOutput(context,"moderation-pending");assert.equal((await context.execution.uploadOutput(claim.fence,prepared.ticket!,PNG_BYTES,"image/png")).result,"moderation_pending");
 context.database.prepare("UPDATE generation_job_items SET lease_expires_at=unixepoch()-1 WHERE id=?").run(claim.fence.itemId);
 assert.deepEqual(await context.queue.recoverExpiredLeases(10),{retried:0,failed:0,reconciliationRequired:0});
 assert.equal(context.database.prepare("SELECT status FROM generation_job_items").get()?.status,"PERSISTING");assert.equal(context.database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE entry_type IN ('SETTLE','RELEASE')").get()?.n,0);
 control.decision="Pass";assert.equal((await context.execution.recoverStoredOutputs(10)).recovered,1);assert.equal(context.database.prepare("SELECT moderation_status FROM assets WHERE kind='output'").get()?.moderation_status,"APPROVED");assert.equal(typeof context.database.prepare("SELECT moderated_at FROM assets WHERE kind='output'").get()?.moderated_at,"number");assert.equal(context.database.prepare("SELECT status FROM generation_jobs").get()?.status,"SUCCEEDED");assert.equal(context.database.prepare("SELECT COUNT(*) n FROM generation_attempts").get()?.n,1);
});
test("Review recovery after lease expiry releases once; failed release rolls back receipt and all state",async()=>{
 const control:{decision:"Pass"|"Review"|"Block"|"unknown"}={decision:"unknown"};let failRelease=false;
 const context=await setupJob("job-moderation-review",statement=>{if(failRelease&&statement.sqlText().includes("INSERT INTO generation_moderation_rejections")){failRelease=false;throw Error("test rejection transaction interruption");}},control);
 const {claim,prepared}=await prepareAuditedOutput(context,"moderation-review");await context.execution.uploadOutput(claim.fence,prepared.ticket!,PNG_BYTES,"image/png");context.database.prepare("UPDATE generation_job_items SET lease_expires_at=unixepoch()-1 WHERE id=?").run(claim.fence.itemId);
 control.decision="Review";failRelease=true;await assert.rejects(context.execution.recoverStoredOutputs(10),/transaction interruption/);assert.equal(context.database.prepare("SELECT status FROM generation_job_items").get()?.status,"PERSISTING");assert.equal(context.database.prepare("SELECT COUNT(*) n FROM generation_moderation_rejections").get()?.n,0);
 await context.execution.recoverStoredOutputs(10);assert.equal(context.database.prepare("SELECT status FROM generation_jobs").get()?.status,"FAILED");assert.equal(context.database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE entry_type='RELEASE'").get()?.n,1);await context.execution.recoverStoredOutputs(10);assert.equal(context.database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE entry_type='RELEASE'").get()?.n,1);
});

function disabledExecution(context:Awaited<ReturnType<typeof setupJob>>) {
 return new InternalQueueExecutionService(context.d1,context.bucket,TICKET_CONFIG,context.queue,false,null,new DisabledModeration(context.d1));
}
test("new disabled output keeps UNREVIEWED, zero evidence and exactly one settlement through replay",async()=>{
 const c=await setupJob("disabled-output");c.execution=disabledExecution(c);
 const {claim,prepared}=await prepareAuditedOutput(c,"disabled-output");assert.equal((await c.execution.uploadOutput(claim.fence,prepared.ticket!,PNG_BYTES,"image/png")).result,"applied");
 const row=c.database.prepare("SELECT status,moderation_mode,moderation_status,moderated_at FROM assets WHERE id IN (SELECT asset_id FROM generation_output_commits)").get();assert.equal(row?.status,"READY");assert.equal(row?.moderation_mode,"disabled");assert.equal(row?.moderation_status,"UNREVIEWED");assert.equal(row?.moderated_at,null);
 assert.equal((await c.execution.uploadOutput(claim.fence,prepared.ticket!,PNG_BYTES,"image/png")).result,"already_applied");assert.equal(c.database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE entry_type='SETTLE'").get()?.n,1);assert.equal(c.database.prepare("SELECT COUNT(*) n FROM asset_moderation_evidence").get()?.n,0);c.database.close();
});
test("legacy NULL and Tencent pending commits never wash into READY after switching disabled",async()=>{
 for(const legacy of [false,true])for(const stored of [false,true]){
  const c=await setupJob(`legacy-${legacy}-${stored}`,undefined,{decision:"unknown"});const prepared=await prepareAuditedOutput(c,`legacy-${legacy}-${stored}`);
  if(legacy){c.database.exec('DROP TRIGGER assets_moderation_mode_immutable');c.database.exec('UPDATE assets SET moderation_mode=NULL WHERE kind=\'output\'');}
  if(stored)assert.equal((await c.execution.uploadOutput(prepared.claim.fence,prepared.prepared.ticket!,PNG_BYTES,"image/png")).result,"moderation_pending");
  c.execution=disabledExecution(c);
  const replay=await c.execution.prepareOutput({fence:prepared.claim.fence,uploadRequestId:`upload-legacy-${legacy}-${stored}`,providerRequestId:`provider-legacy-${legacy}-${stored}`,promptTemplateVersion:"test",sanitizationVersion:"canonical-image-v1",mimeType:"image/png",byteSize:PNG_BYTES.byteLength,sha256:digest(PNG_BYTES)});assert.equal(replay.result,"already_prepared");
  assert.equal((await c.execution.uploadOutput(prepared.claim.fence,prepared.prepared.ticket!,PNG_BYTES,"image/png")).result,"moderation_pending");await c.execution.recoverStoredOutputs(10);
  assert.equal(c.database.prepare("SELECT COUNT(*) n FROM generation_job_outputs").get()?.n,0);assert.equal(c.database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries WHERE entry_type='SETTLE'").get()?.n,0);assert.equal(c.database.prepare("SELECT moderation_mode FROM assets WHERE kind='output'").get()?.moderation_mode,legacy?null:"tencent");c.database.close();
 }
});
test("disabled historical denial returns 422 without Tencent refund receipt or output relation",async()=>{
 const c=await setupJob("disabled-denial");c.execution=disabledExecution(c);const {claim,prepared}=await prepareAuditedOutput(c,"disabled-denial");
 c.database.prepare("INSERT INTO asset_moderation_evidence(asset_id,content_sha256,policy_version,request_id,decision) VALUES(?,?,'old','old','Review')").run(`source-disabled-denial`,digest(PNG_BYTES));
 await assert.rejects(c.execution.uploadOutput(claim.fence,prepared.ticket!,PNG_BYTES,"image/png"),error=>error instanceof Error&&'status' in error&&error.status===422);
 assert.equal(c.database.prepare("SELECT COUNT(*) n FROM generation_moderation_rejections").get()?.n,0);assert.equal(c.database.prepare("SELECT COUNT(*) n FROM generation_job_outputs").get()?.n,0);assert.equal(c.database.prepare("SELECT state FROM generation_output_commits").get()?.state,"OBJECT_STORED");c.database.close();
});
