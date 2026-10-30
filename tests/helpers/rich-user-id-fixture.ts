// Entirely synthetic offline rows, created through real queue/output/recharge services.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { TestD1Database } from './test-d1';
import { TestR2Bucket } from './test-r2';
import { testModeration } from './test-moderation';
import { InternalQueueService } from '../../lib/server/internal-queue-service';
import { D1GenerationQueue } from '../../lib/server/generation-queue';
import { InternalQueueExecutionService } from '../../lib/server/internal-queue-execution';
import { createD1QueuedJobIdempotently, type D1QueuedJobRecord } from '../../lib/server/queued-job-creation';
import { createRechargeOrder } from '../../lib/server/recharge-orders';
import { createNativeOrder } from '../../lib/server/recharge-native-orders';
import { requeueFailedBeforeProvider } from '../../lib/server/generation-safe-requeue';
import assert from 'node:assert/strict';

const database=new DatabaseSync(process.argv[2]);database.exec('PRAGMA foreign_keys=ON');
const d1=new TestD1Database(database),owner='user_old';
const bytes=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64'));
const sha=createHash('sha256').update(bytes).digest('hex');
const queue=new D1GenerationQueue(d1),bucket=new TestR2Bucket(),control:{decision:'Pass'|'Block'}={decision:'Pass'};
const transitions=new InternalQueueService(queue,{leaseSeconds:180,ownerConcurrency:1,providerConcurrency:1,sweepLimit:50});
const service=new InternalQueueExecutionService(d1,bucket,{audience:'fixture',secret:'synthetic-ticket-secret-material-at-least-32',ttlSeconds:240},queue,false,null,testModeration(d1,control));
function job(id:string):D1QueuedJobRecord{return {id,ownerId:owner,sourceAssetId:null,referenceAssetId:null,additionalReferencesJson:'[]',maskAssetId:null,depthAssetId:null,normalAssetId:null,workflowType:'self-service',purpose:'final',sourceJobId:null,promotedFromAssetId:null,resolution:'1K',effectiveResolution:'1K',aspectRatio:'1:1',quality:'standard',visualRealism:'photorealistic',lampState:'mixed',colorTemperatureKelvin:4000,stylePresetId:'self-service',designSchemeId:null,lightingPreset:'noon',preservationMode:'structure',providerPreference:'doubao-seedream-4-5-251128',editInstruction:null,customPrompt:'synthetic fixture',outputCount:1,advancedSettingsJson:'{}',idempotencyKey:id,requestHash:id,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
async function claim(id:string){await createD1QueuedJobIdempotently(d1,job(id),{amountPerItem:1,priceVersion:'test-v1'});const c=await queue.claimNextEligible({workerId:'fixture',claimRequestId:id});assert.ok(c);return c;}
async function output(id:string){const c=await claim(id);assert.equal(await queue.transition(c.fence,'LEASED','PREPROCESSING'),true);await transitions.transition({fence:c.fence,event:'BEGIN_PROVIDER_DISPATCH',providerAccountSlot:'seedream-primary'});await transitions.transition({fence:c.fence,event:'RECORD_PROVIDER_RESPONSE',providerRequestId:'provider-'+id});const prepared=await service.prepareOutput({fence:c.fence,uploadRequestId:'upload-'+id,providerRequestId:'provider-'+id,promptTemplateVersion:'test',sanitizationVersion:'canonical-image-v1',mimeType:'image/png',byteSize:bytes.length,sha256:sha});assert.ok(prepared.ticket);return service.uploadOutput(c.fence,prepared.ticket,bytes,'image/png');}
try{
 database.prepare('INSERT INTO user_generation_limits(owner_id) VALUES(?)').run(owner);
 const success=await output('rich-success');assert.equal(success.result,'applied');
 control.decision='Block';assert.equal((await output('rich-block')).result,'rejected');
 const reconcile=await claim('rich-reconciliation');await queue.transition(reconcile.fence,'LEASED','PREPROCESSING');await queue.transition(reconcile.fence,'PREPROCESSING','SUBMITTING');await queue.transition(reconcile.fence,'SUBMITTING','RECONCILIATION_REQUIRED',{errorCode:'SYNTHETIC_TIMEOUT'});
 const caseId=String(database.prepare('SELECT id FROM generation_reconciliation_cases LIMIT 1').get()?.id);database.prepare("INSERT INTO generation_reconciliation_events(id,case_id,action_id,action,actor_id,to_state,note) VALUES('rich-event',?,'rich-event','OBSERVE',?,'OPEN','synthetic')").run(caseId,owner);
 const safe=await claim('rich-safe');await queue.scheduleSafeRetry(safe.fence,'LEASED',{errorCode:'SAFE_TEST_FAILURE',errorMessage:'safe failure',errorRetryable:false},0);await requeueFailedBeforeProvider({itemId:safe.item.id,action:'REQUEUE_BEFORE_PROVIDER',actionId:'rich-safe-requeue',actorId:owner,requestId:'rich-safe-request'},d1);
 await createRechargeOrder(d1,{ownerId:owner,provider:'WECHAT_PAY',productCode:'CNY10',idempotencyKey:'rich-recharge-v1'});await createNativeOrder(d1,owner,'CNY20','rich-recharge-v2');
 database.prepare("INSERT INTO auth_identities(id,user_id,provider,provider_app_id,subject_hash) VALUES('rich-identity',?,'email','email:v1','synthetic-subject')").run(owner);
 database.prepare("INSERT INTO user_legal_acceptances(user_id,document,version,accepted_at) VALUES(?,'terms','synthetic',1)").run(owner);
 database.prepare("INSERT INTO studio_templates(id,owner_id,workflow_type,name,config_json) VALUES('rich-template',?,'self-service','synthetic','{}')").run(owner);
 database.prepare("INSERT INTO text_moderation_evidence(owner_id,content_sha256,policy_version,request_id,decision) VALUES(?,?,'old','synthetic','Review')").run(owner,sha);
 database.prepare("INSERT INTO gallery_items(id,owner_id,source_asset_id,category,title,consent_version,image_consent_at,thumb_key,display_key,thumb_bytes,display_bytes,thumb_sha256,display_sha256,width,height,status,submitted_at,updated_at,reviewer_owner_id) VALUES('rich-gallery',?,?,'living-room','synthetic','v1','now','thumb','display',1,1,?,?,1,1,'PENDING','now','now',?)").run(owner,success.assetId,sha,sha,owner);
 database.prepare("INSERT INTO gallery_audit_events(id,action_id,gallery_id,actor_id,action,detail_hash) VALUES('rich-gallery-audit','rich-gallery-audit','rich-gallery',?,'SUBMIT','original-hash')").run(owner);
 database.prepare("INSERT INTO asset_maintenance_events(id,action_id,actor_id,action,detail_hash,request_id) VALUES('rich-maintenance','rich-maintenance',?,'RETRY_BLOCKED_CLEANUP','original-hash','request')").run(owner);
 database.prepare("INSERT INTO asset_moderation_events(id,action_id,asset_id,reviewer_id,decision,reason_hash) VALUES('rich-review','rich-review',?,?,'APPROVED','original-hash')").run(success.assetId,owner);
 database.prepare("INSERT INTO asset_deletion_events(id,action_id,asset_id,actor_id,source,detail_hash) VALUES('rich-deletion','rich-deletion','asset',?,'USER_REQUEST','original-hash')").run(owner);
 assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(),[]);
}finally{database.close();}
