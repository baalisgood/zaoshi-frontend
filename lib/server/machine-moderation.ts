import { createHash } from "node:crypto";
import { ApiError } from "./api";
import { IMAGE_SANITIZATION_VERSION } from "@/lib/platform/image-sanitizer";
import { assertModerationPass, moderateContent, moderationConfig, moderationPolicy, type ModerationConfig, type ModerationEvidence } from "./tencent-moderation";
export interface ContentModeration { readonly mode:"disabled"|"tencent"; readonly policyVersion:string|null; asset(ownerId:string,assetId:string,bytes:Uint8Array):Promise<void>; text(ownerId:string,text:string):Promise<void>; }
export class MachineModeration implements ContentModeration {
 readonly mode = "tencent" as const;
 get policyVersion():string{return moderationPolicy(this.config);}
 constructor(private readonly d1:D1Database,private readonly config:ModerationConfig,private readonly transport:typeof fetch=fetch){}
 async text(ownerId:string,text:string):Promise<void>{
  const account=await this.d1.prepare("SELECT id FROM users WHERE id=? AND status='ACTIVE'").bind(ownerId).first();if(!account)throw stale();
  if(!text.trim())return;
  const evidence=await moderateContent("text",text,this.config,this.transport);
  await this.d1.prepare(`INSERT INTO text_moderation_evidence(owner_id,content_sha256,policy_version,request_id,decision) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND status='ACTIVE') ON CONFLICT(owner_id,content_sha256,policy_version) DO NOTHING`).bind(ownerId,evidence.sha256,evidence.policy,evidence.requestId,evidence.decision,ownerId).run();
  const active=await this.d1.prepare("SELECT id FROM users WHERE id=? AND status='ACTIVE'").bind(ownerId).first();if(!active)throw stale();assertModerationPass(evidence);
 }
 async asset(ownerId:string,assetId:string,bytes:Uint8Array):Promise<void>{
  const sha=createHash("sha256").update(bytes).digest("hex");
  const current=await this.d1.prepare("SELECT sha256,sanitization_version,status FROM assets WHERE id=? AND owner_id=?").bind(assetId,ownerId).first<{sha256:string;sanitization_version:string;status:string}>();
  if(!current||current.sha256!==sha||current.sanitization_version!==IMAGE_SANITIZATION_VERSION||!["PENDING","READY"].includes(current.status))throw stale();
  const cached=await this.d1.prepare("SELECT request_id,decision FROM asset_moderation_evidence WHERE asset_id=? AND content_sha256=? AND policy_version=?").bind(assetId,sha,this.policyVersion).first<{request_id:string;decision:ModerationEvidence["decision"]}>();
  const evidence=cached?{sha256:sha,policy:this.policyVersion,requestId:cached.request_id,decision:cached.decision}:await moderateContent("image",bytes,this.config,this.transport);
  if(!cached)await this.d1.prepare(`INSERT INTO asset_moderation_evidence(asset_id,content_sha256,policy_version,request_id,decision) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assets a JOIN users u ON u.id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.sha256=? AND a.sanitization_version=? AND a.status IN ('PENDING','READY') AND u.status='ACTIVE') ON CONFLICT(asset_id,content_sha256,policy_version) DO NOTHING`).bind(assetId,sha,evidence.policy,evidence.requestId,evidence.decision,assetId,ownerId,sha,IMAGE_SANITIZATION_VERSION).run();
  const accepted=await this.d1.prepare(`SELECT e.decision FROM asset_moderation_evidence e JOIN assets a ON a.id=e.asset_id JOIN users u ON u.id=a.owner_id WHERE e.asset_id=? AND a.owner_id=? AND e.content_sha256=a.sha256 AND e.content_sha256=? AND e.policy_version=? AND a.status IN ('PENDING','READY') AND u.status='ACTIVE'`).bind(assetId,ownerId,sha,this.policyVersion).first<{decision:ModerationEvidence["decision"]}>();
  if(!accepted)throw stale();assertModerationPass({...evidence,decision:accepted.decision});
 }
}
export function moderationMode(bindings: Record<string, unknown>): "disabled" | "tencent" {
 const value=bindings.TENCENT_MODERATION_ENABLED;
 if(value===undefined||value===null||value===""||value==="0")return "disabled";
 if(value==="1")return "tencent";
 throw new ApiError(503,"MODERATION_UNAVAILABLE","内容检查配置无效。");
}
export class DisabledModeration implements ContentModeration {
 readonly mode="disabled" as const; readonly policyVersion=null;
 constructor(private readonly d1:D1Database){}
 async text(ownerId:string,text:string):Promise<void>{
  if(!await this.d1.prepare("SELECT 1 FROM users WHERE id=? AND status='ACTIVE'").bind(ownerId).first())throw stale();
  if(!text.trim())return;
  const sha=createHash("sha256").update(text).digest("hex");
  if(await this.d1.prepare("SELECT decision FROM text_moderation_evidence WHERE owner_id=? AND content_sha256=? AND decision IN ('Review','Block') LIMIT 1").bind(ownerId,sha).first())throw blocked();
 }
 async asset(ownerId:string,assetId:string,bytes:Uint8Array):Promise<void>{
  const sha=createHash("sha256").update(bytes).digest("hex");
  const asset=await this.d1.prepare("SELECT a.moderation_status FROM assets a JOIN users u ON u.id=a.owner_id WHERE a.id=? AND a.owner_id=? AND a.sha256=? AND a.sanitization_version=? AND a.status IN ('PENDING','READY') AND u.status='ACTIVE'").bind(assetId,ownerId,sha,IMAGE_SANITIZATION_VERSION).first<{moderation_status:string}>();
  if(!asset)throw stale();
  if(asset.moderation_status==='REJECTED'||await this.d1.prepare("SELECT e.decision FROM asset_moderation_evidence e JOIN assets a ON a.id=e.asset_id WHERE a.owner_id=? AND e.content_sha256=? AND e.decision IN ('Review','Block') LIMIT 1").bind(ownerId,sha).first())throw blocked();
 }
}
function blocked():ApiError{return new ApiError(422,"CONTENT_REVIEW_REQUIRED","内容曾被审核拒绝，请更换内容。");}
export async function runtimeModeration(d1:D1Database):Promise<ContentModeration>{const {readRuntimeBindings}=await import("@/lib/platform/cloudflare-runtime");const bindings=readRuntimeBindings();return moderationMode(bindings)==="disabled"?new DisabledModeration(d1):new MachineModeration(d1,moderationConfig(bindings));}
function stale():ApiError{return new ApiError(409,"MODERATION_CONTENT_CHANGED","内容或账户状态已变化，请重新确认。");}

export async function auditGenerationInputs(ownerId:string,customText:string,assets:readonly {id:string}[],readBytes:(asset:{id:string})=>Promise<Uint8Array>):Promise<{requireMachineModeration:boolean;moderationPolicyVersion?:string}>{
 const {getD1Binding}=await import("@/db");const d1=getD1Binding();if(!d1)throw new ApiError(503,"MODERATION_UNAVAILABLE","内容检查服务暂不可用。");
 const audit=await runtimeModeration(d1);await audit.text(ownerId,customText);
 for(const asset of assets)await audit.asset(ownerId,asset.id,await readBytes(asset));
 return {requireMachineModeration:audit.mode==="tencent",...(audit.policyVersion?{moderationPolicyVersion:audit.policyVersion}:{})};
}
