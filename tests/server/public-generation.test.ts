import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicImageGenerationActor, assertDomesticGenerationQueueReady, assertGenerationRuntime } from "../../lib/server/runtime-policy";
import { imageModelValues } from "../../lib/domain/image-models";
import { parseCreateJobInput } from "../../lib/server/job-contract";
const environment = { BACKEND_PROFILE: "cn-production" as const, AUTH_MODE: "email", PUBLIC_IMAGE_GENERATION_ENABLED: "1", GENERATION_INTERNAL_API_ENABLED: "1", OVERSEAS_RELAY_ENABLED: "1", ARK_API_KEY: "fake-test-key", DASHSCOPE_API_KEY: "fake-test-key", DASHSCOPE_WORKSPACE_ID: "test-workspace" };
const actor = { ownerId: "email-user", trusted: true, setCookie: null, user: { authenticated: true, email: "verified@example.test", role: "USER" as const, displayName: "test" } };
test("production image flag is independent of private expiry, authenticated email and optimizer gates", () => {
  for (const model of imageModelValues) { assert.doesNotThrow(()=>assertDomesticGenerationQueueReady(model,environment)); assert.doesNotThrow(()=>assertGenerationRuntime(model,environment)); }
  assert.doesNotThrow(()=>assertPublicImageGenerationActor(actor,environment));
  for (const bad of [{...environment,PUBLIC_IMAGE_GENERATION_ENABLED:"0"},{...environment,AUTH_MODE:"private-test"},{...environment,GENERATION_INTERNAL_API_ENABLED:"0"}]) assert.throws(()=>assertPublicImageGenerationActor(actor,bad));
  for (const bad of [{...actor,trusted:false},{...actor,user:{...actor.user,email:undefined}},{...actor,user:{...actor.user,authenticated:false}}]) assert.throws(()=>assertPublicImageGenerationActor(bad,environment));
  assert.throws(()=>assertGenerationRuntime("gemini-3-pro-image",{...environment,OVERSEAS_RELAY_ENABLED:"0"}));
});
test("new custom prompt respects original 2000 character limit without truncating", () => {
  const body = {workflowType:"self-service",purpose:"final",providerPreference:"gpt-image-2",resolution:"1K",quality:"low",aspectRatio:"1:1",outputCount:1,idempotencyKey:"boundary-prompt",customPrompt:"x".repeat(2000)};
  assert.equal(parseCreateJobInput(body).customPrompt?.length,2000);
  assert.throws(()=>parseCreateJobInput({...body,customPrompt:"x".repeat(2001)}));
});
