import { createHash } from "node:crypto";
import type { ContentModeration } from "../../lib/server/machine-moderation";
import { ApiError } from "../../lib/server/api";
import { assertModerationPass } from "../../lib/server/tencent-moderation";
// Only constructor-injected test fixtures; no runtime environment can select this adapter.
export function testModeration(d1:D1Database, control:{decision:"Pass"|"Review"|"Block"|"unknown"}={decision:"Pass"}):ContentModeration {
 const policyVersion="tencent-20261006-v1:0000000000000000";
 return {mode:"tencent",policyVersion,async text(){if(control.decision==="unknown")throw new ApiError(503,"MODERATION_UNAVAILABLE","test unavailable");},async asset(ownerId,id,bytes){
  if(control.decision==="unknown")throw new ApiError(503,"MODERATION_UNAVAILABLE","test unavailable");
  const evidence={sha256:createHash("sha256").update(bytes).digest("hex"),policy:policyVersion,requestId:"test-request-"+id,decision:control.decision};
  await d1.prepare(`INSERT INTO asset_moderation_evidence(asset_id,content_sha256,policy_version,request_id,decision) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assets WHERE id=? AND owner_id=? AND sha256=?) ON CONFLICT(asset_id,content_sha256,policy_version) DO NOTHING`).bind(id,evidence.sha256,evidence.policy,evidence.requestId,evidence.decision,id,ownerId,evidence.sha256).run();
  assertModerationPass(evidence);
 }};
}
