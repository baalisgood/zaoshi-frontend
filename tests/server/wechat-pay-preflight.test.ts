import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("payment preflight reports only metadata and never echoes supplied config values",()=>{
 const result=spawnSync(process.execPath,["scripts/wechat-pay-preflight.mjs"],{encoding:"utf8",env:{NODE_ENV:"test",WECHAT_PAY_APP_ID:"DO_NOT_PRINT_APP_ID",WECHAT_PAY_API_V3_KEY_FILE:"/private/tmp/DO_NOT_READ_SECRET",WECHAT_PAY_PRIVATE_KEY_FILE:"/run/secrets/../../private/tmp/DO_NOT_READ_PRIVATE"}});
 assert.equal(result.status,1);assert.equal(result.stderr,"");assert.doesNotMatch(result.stdout,/DO_NOT_PRINT|DO_NOT_READ/);
 const data=JSON.parse(result.stdout);assert.equal(data.scope,"metadata_only_no_payment_request");assert.equal(data.configurationMetadataComplete,false);assert.equal(data.realPaymentVerified,false);assert.equal(data.fields.WECHAT_PAY_APP_ID,"configured");assert.equal(data.fields.WECHAT_PAY_API_V3_KEY_FILE,"unsafe_or_unavailable");assert.equal(data.fields.WECHAT_PAY_PRIVATE_KEY_FILE,"unsafe_or_unavailable");assert.equal(data.fields.WECHAT_PAY_PUBLIC_KEY_FILE,"missing");
});
test("empty configuration preflight exits nonzero without reading any credential",()=>{
 const result=spawnSync(process.execPath,["scripts/wechat-pay-preflight.mjs"],{encoding:"utf8",env:{NODE_ENV:"test"}});assert.equal(result.status,1);const data=JSON.parse(result.stdout);assert.ok(Object.values(data.fields).every(value=>value==="missing"));assert.equal(data.realPaymentVerified,false);
});
