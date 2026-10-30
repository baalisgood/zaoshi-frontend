import { type RequestActor } from "./actor";
import { ApiError } from "./api";
import { imageModelSupportsResolution, imageModelValues } from "@/lib/domain/image-models";

export const PRIVATE_TEST_MODELS = imageModelValues;
import { PRIVATE_TEST_OWNER, assertPrivateTestActor, type PrivateTestConfig } from "./private-test-policy";
export { PRIVATE_TEST_OWNER, assertPrivateTestActive, assertPrivateTestActor, type PrivateTestConfig } from "./private-test-policy";
const ORIGIN = "http://127.0.0.1:3000";
export type PrivateTestStoredJob = { owner_id: string; provider_preference: string; purpose: string; effective_resolution: string; output_count: number; mask_asset_id: string | null; depth_asset_id: string | null; normal_asset_id: string | null; source_job_id: string | null; promoted_from_asset_id: string | null };

// ponytail: one operator's SSH-only test realm; public login continues to use WeChat.
export function resolvePrivateTestConfig(bindings: Record<string, unknown>, now = Math.floor(Date.now() / 1000), allowExpired = false): PrivateTestConfig | null {
  if (bindings.ZAOSHI_PRIVATE_TEST_ENABLED !== "1") return null;
  const expiresAt = Number(bindings.PRIVATE_TEST_EXPIRES_AT);
  if (bindings.AUTH_MODE !== "private-test" || bindings.ZAOSHI_RUNTIME !== "node" || bindings.BACKEND_PROFILE !== "cn-production" || bindings.TRUST_PLATFORM_IDENTITY_HEADERS !== "0" || bindings.GENERATION_INTERNAL_API_ENABLED !== "1" || bindings.ZAOSHI_SQLITE_PATH !== "/var/lib/zaoshi/web-private-test/db/zaoshi.sqlite" || bindings.ZAOSHI_OBJECT_ROOT !== "/var/lib/zaoshi/web-private-test/objects" || !Number.isSafeInteger(expiresAt) || (!allowExpired && expiresAt <= now) || expiresAt > now + 86_400) return null;
  return { expiresAt };
}

export function requirePrivateTestConfig(bindings: Record<string, unknown>, now = Math.floor(Date.now() / 1000)): PrivateTestConfig | null {
  // Allow only fenced completion/recovery after expiry; new claims and dispatches check the deadline below.
  const config = resolvePrivateTestConfig(bindings, now, true);
  if (bindings.AUTH_MODE === "private-test" && !config) throw new ApiError(503, "PRIVATE_TEST_EXPIRED", "付费私测配置无效或已到期，任务队列已停止。");
  return config;
}

export function assertPrivateTestRequest(request: Request, config: PrivateTestConfig | null, mutation = false): asserts config is PrivateTestConfig {
  const url = new URL(request.url);
  if (!config || url.origin !== ORIGIN || (mutation && request.headers.get("origin") !== ORIGIN)) throw new ApiError(404, "NOT_FOUND", "私测入口未启用或已到期。");
}

export async function getPrivateTestActor(request: Request, config: PrivateTestConfig, d1: D1Database): Promise<RequestActor | null> {
  assertPrivateTestRequest(request, config);
  const legacy = await d1.prepare("SELECT id FROM users WHERE id='user_web_private_test' OR (identity_namespace='user_web_private_test' AND id<>?)").bind(PRIVATE_TEST_OWNER).first();
  const current = await d1.prepare("SELECT status,role FROM users WHERE id=?").bind(PRIVATE_TEST_OWNER).first<{status:string;role:string}>();
  const currentLimits = await d1.prepare("SELECT daily_output_limit,max_pending_outputs,active_concurrency_limit,enabled FROM user_generation_limits WHERE owner_id=?").bind(PRIVATE_TEST_OWNER).first<{daily_output_limit:number;max_pending_outputs:number;active_concurrency_limit:number;enabled:number}>();
  if (legacy || (current && (current.status !== "ACTIVE" || current.role !== "USER" || currentLimits?.daily_output_limit !== 20 || currentLimits.max_pending_outputs !== 1 || currentLimits.active_concurrency_limit !== 1 || currentLimits.enabled !== 1)) || (!current && currentLimits)) throw new ApiError(409,"PRIVATE_TEST_ACCOUNT_CONFLICT","私测账号配置不一致，已停止访问。");
  const noLegacy = "NOT EXISTS(SELECT 1 FROM users WHERE id='user_web_private_test' OR (identity_namespace='user_web_private_test' AND id<>'TEST0001'))";
  const active = "EXISTS(SELECT 1 FROM users WHERE id='TEST0001' AND status='ACTIVE' AND role='USER')";
  const bounded = "EXISTS(SELECT 1 FROM user_generation_limits WHERE owner_id='TEST0001' AND daily_output_limit=20 AND max_pending_outputs=1 AND active_concurrency_limit=1 AND enabled=1)";
  await d1.batch([
    d1.prepare(`INSERT OR IGNORE INTO users (id,display_name,status,role) SELECT ?, '造室付费私测','ACTIVE','USER' WHERE ${noLegacy}`).bind(PRIVATE_TEST_OWNER),
    d1.prepare(`INSERT OR IGNORE INTO user_generation_limits(owner_id,daily_output_limit,max_pending_outputs,active_concurrency_limit,enabled) SELECT ?,20,1,1,1 WHERE ${noLegacy} AND ${active}`).bind(PRIVATE_TEST_OWNER),
    d1.prepare(`INSERT INTO credit_ledger_entries(id,owner_id,entry_type,amount,idempotency_key,reason_code,actor_id,request_id) SELECT ?,?,'CREDIT',1000,'private-test-initial-budget-v1','PRIVATE_TEST_BUDGET','system','private-test-bootstrap-v1' WHERE ${noLegacy} AND ${active} AND ${bounded} ON CONFLICT(owner_id,idempotency_key) DO NOTHING`).bind(`ledger_credit_${crypto.randomUUID()}`,PRIVATE_TEST_OWNER),
  ]);
  const credit = await d1.prepare("SELECT entry_type,amount,reason_code,actor_id FROM credit_ledger_entries WHERE owner_id=? AND idempotency_key='private-test-initial-budget-v1'").bind(PRIVATE_TEST_OWNER).first<{entry_type:string;amount:number;reason_code:string;actor_id:string}>();
  if (credit && (credit.entry_type !== "CREDIT" || credit.amount !== 1000 || credit.reason_code !== "PRIVATE_TEST_BUDGET" || credit.actor_id !== "system")) throw new ApiError(409,"IDEMPOTENCY_CONFLICT","该积分入账标识已经用于其他操作。");
  const account = await d1.prepare("SELECT status, role, identity_namespace FROM users WHERE id = ?").bind(PRIVATE_TEST_OWNER).first<{ status: string; role: string; identity_namespace:string }>();
  const limits = await d1.prepare("SELECT daily_output_limit, max_pending_outputs, active_concurrency_limit, enabled FROM user_generation_limits WHERE owner_id = ?").bind(PRIVATE_TEST_OWNER).first<{ daily_output_limit: number; max_pending_outputs: number; active_concurrency_limit: number; enabled: number }>();
  if (account?.status !== "ACTIVE" || account.role !== "USER" || limits?.daily_output_limit !== 20 || limits.max_pending_outputs !== 1 || limits.active_concurrency_limit !== 1 || limits.enabled !== 1) throw new ApiError(409, "PRIVATE_TEST_ACCOUNT_CONFLICT", "私测账号配置不一致，已停止访问。");
  return { ownerId: PRIVATE_TEST_OWNER, identityNamespace: account.identity_namespace, setCookie: null, trusted: true, user: { authenticated: true, displayName: "造室付费私测", role: "USER" } };
}

export function assertPrivateTestJob(actor: RequestActor, job: { providerPreference: string; purpose: string; effectiveResolution: string; outputCount: number; maskAssetId?: string | null; depthAssetId?: string | null; normalAssetId?: string | null }): void {
  assertPrivateTestActor(actor);
  if (!(PRIVATE_TEST_MODELS as readonly string[]).includes(job.providerPreference)) throw new ApiError(400, "PRIVATE_TEST_MODEL_FORBIDDEN", "付费私测仅开放当前已接入的十二个 Seedream / Qwen / Google / OpenAI 模型。");
  if ((job.purpose !== "preview" && job.purpose !== "final") || !imageModelSupportsResolution(job.providerPreference as typeof PRIVATE_TEST_MODELS[number], job.effectiveResolution) || !Number.isSafeInteger(job.outputCount) || job.outputCount < 1 || job.outputCount > (job.purpose === "preview" ? 1 : 4) || job.maskAssetId) throw new ApiError(400, "PRIVATE_TEST_SPEC_FORBIDDEN", "付费私测仅支持当前模型已接入规格、成品每次1到4张逐张执行，且不启用蒙版。");
}

export function assertPrivateTestStoredJob(job: PrivateTestStoredJob): void {
  if (job.owner_id !== PRIVATE_TEST_OWNER) throw new ApiError(409, "PRIVATE_TEST_OWNER_CONFLICT", "私测任务不属于固定测试账号。");
  if (!(PRIVATE_TEST_MODELS as readonly string[]).includes(job.provider_preference)) throw new ApiError(409, "PRIVATE_TEST_MODEL_FORBIDDEN", "私测任务模型不在允许范围内。");
  if ((job.purpose !== "preview" && job.purpose !== "final") || !imageModelSupportsResolution(job.provider_preference as typeof PRIVATE_TEST_MODELS[number], job.effective_resolution) || !Number.isSafeInteger(job.output_count) || job.output_count < 1 || job.output_count > (job.purpose === "preview" ? 1 : 4) || job.mask_asset_id) throw new ApiError(409, "PRIVATE_TEST_SPEC_FORBIDDEN", "私测任务配置已被修改，停止执行。");
  if (job.source_job_id || job.promoted_from_asset_id) throw new ApiError(409, "PRIVATE_TEST_FINALIZE_FORBIDDEN", "付费私测不开放参考图晋升成品图，请直接提交单次任务。");
}

export async function assertPrivateTestQueueItem(d1: D1Database, itemId: string): Promise<void> {
  const job = await d1.prepare(
    `SELECT job.owner_id, job.provider_preference, job.purpose, job.effective_resolution,
            job.output_count, job.mask_asset_id, job.depth_asset_id, job.normal_asset_id,
            job.source_job_id, job.promoted_from_asset_id
     FROM generation_job_items AS item
     JOIN generation_jobs AS job ON job.id = item.job_id
     WHERE item.id = ? AND item.execution_kind = 'provider'`,
  ).bind(itemId).first<PrivateTestStoredJob>();
  if (!job) throw new ApiError(409, "PRIVATE_TEST_ITEM_CONFLICT", "私测队列任务不存在或类型不正确。");
  assertPrivateTestStoredJob(job);
}
