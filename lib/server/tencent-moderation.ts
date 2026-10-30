import { detectImageMime, readImageMetadata } from "@/lib/ai/image-metadata";
import { createHash, createHmac } from "node:crypto";
import { ApiError } from "./api";
import { readBoundedJsonResponse } from "./bounded-response";

export const MODERATION_POLICY = "tencent-20261006-v1";
export type ModerationEvidence = { sha256: string; policy: string; requestId: string; decision: "Pass" | "Review" | "Block" };
export type ModerationConfig = { secretId: string; secretKey: string; region: string; bizType: string };
export function moderationConfig(env: Record<string, unknown>): ModerationConfig {
 const names = ["TENCENT_MODERATION_SECRET_ID", "TENCENT_MODERATION_SECRET_KEY", "TENCENT_MODERATION_REGION", "TENCENT_MODERATION_BIZ_TYPE"];
 if (env.TENCENT_MODERATION_ENABLED !== "1" || names.some(name => typeof env[name] !== "string" || !(env[name] as string).trim())) throw unavailable();
 return { secretId: String(env[names[0]]), secretKey: String(env[names[1]]), region: String(env[names[2]]), bizType: String(env[names[3]]) };
}
export const moderationPolicy = (config: ModerationConfig): string => `${MODERATION_POLICY}:${createHash("sha256").update(`${config.bizType}\n${config.region}`).digest("hex").slice(0,16)}`;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
export function signModeration(body: string, kind: "text" | "image", config: ModerationConfig, timestamp: number): string {
 const service = kind === "text" ? "tms" : "ims";
 const host = `${service}.tencentcloudapi.com`;
 const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
 const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${hash(body)}`;
 const scope = `${date}/${service}/tc3_request`;
 const signing = hmac(hmac(hmac("TC3" + config.secretKey, date), service), "tc3_request");
 const signature = createHmac("sha256", signing).update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`).digest("hex");
 return `TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`;
}
export async function moderateContent(kind: "text" | "image", content: string | Uint8Array, config: ModerationConfig, transport: typeof fetch = fetch): Promise<ModerationEvidence> {
 const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
 if (kind === "text" && (typeof content !== "string" || [...content].length > 10000)) throw new ApiError(400, "MODERATION_TEXT_TOO_LARGE", "文字过长，请精简后重试。");
 if (kind === "image") {
  const detected=detectImageMime(bytes);const dimensions=detected?readImageMetadata({bytes,mimeType:detected.mimeType}):null;
  if(!dimensions?.width||!dimensions.height||dimensions.width<=50||dimensions.height<=50||dimensions.width>=10000||dimensions.height>=10000||Math.max(dimensions.width/dimensions.height,dimensions.height/dimensions.width)>=90)throw new ApiError(400,"MODERATION_IMAGE_DIMENSIONS","图片尺寸不符合内容检查要求，请调整原图后重试。");
 }
 const body = JSON.stringify({ BizType: config.bizType, [kind === "text" ? "Content" : "FileContent"]: bytes.toString("base64") });
 if (Buffer.byteLength(body) >= 10000000) throw new ApiError(400, "MODERATION_IMAGE_TOO_LARGE", "图片超出内容检查大小限制，请压缩原图后重试。");
 const timestamp = Math.floor(Date.now() / 1000);
 const service = kind === "text" ? "tms" : "ims";
 try {
  const response = await transport(`https://${service}.tencentcloudapi.com/`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json; charset=utf-8", Authorization: signModeration(body, kind, config, timestamp), "X-TC-Action": kind === "text" ? "TextModeration" : "ImageModeration", "X-TC-Version": "2020-12-29", "X-TC-Region": config.region, "X-TC-Timestamp": String(timestamp) }, body });
  if (!response.ok) throw unavailable();
  const parsed = await readBoundedJsonResponse<{ Response?: { Error?: unknown; Suggestion?: string; RequestId?: string } }>(response, { maxBytes: 65536, tooLargeCode: "MODERATION_UNAVAILABLE", invalidCode: "MODERATION_UNAVAILABLE", label: "内容检查服务" });
  const result = parsed.Response;
  if (!result || result.Error || !["Pass", "Review", "Block"].includes(result.Suggestion ?? "") || typeof result.RequestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result.RequestId)) throw unavailable();
  return { sha256: hash(bytes), policy: moderationPolicy(config), requestId: result.RequestId, decision: result.Suggestion as ModerationEvidence["decision"] };
 } catch { throw unavailable(); }
}
export function assertModerationPass(evidence: ModerationEvidence): void {
 if (evidence.decision === "Review") throw new ApiError(422, "CONTENT_REVIEW_REQUIRED", "内容需要进一步确认，请调整后重试。");
 if (evidence.decision === "Block") throw new ApiError(422, "CONTENT_BLOCKED", "内容未通过检查，请调整后重试。");
}
function unavailable(): ApiError { return new ApiError(503, "MODERATION_UNAVAILABLE", "内容检查服务暂不可用，请稍后重试。"); }
