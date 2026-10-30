import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readNodeSecretBindings } from "../../lib/platform/node-secret-files";

const CURRENT_SECRET = "current-machine-secret-at-least-thirty-two-bytes";
const TICKET_SECRET = "ticket-signing-secret-at-least-thirty-two-bytes";

test("Node Web resolves internal queue secrets from private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "zaoshi-node-secrets-"));
  try {
    await writeFile(join(root, "consumer-hmac"), CURRENT_SECRET, { mode: 0o600 });
    await writeFile(join(root, "queue-ticket"), TICKET_SECRET, { mode: 0o600 });
    const bindings = readNodeSecretBindings(
      {
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_CURRENT_SECRET_FILE: join(root, "consumer-hmac"),
        GENERATION_INTERNAL_TICKET_SECRET_FILE: join(root, "queue-ticket"),
      },
      { secretRoot: root, effectiveUid: process.geteuid?.() },
    );
    assert.deepEqual(bindings, {
      GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
      GENERATION_INTERNAL_TICKET_SECRET: TICKET_SECRET,
    });
    assert.equal(JSON.stringify(bindings).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node Web requires WeChat and session secrets from private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "zaoshi-node-auth-secrets-"));
  try {
    const values = {
      WECHAT_OPEN_SECRET: "wechat-secret-at-least-thirty-two-bytes",
      SESSION_SECRET: "session-secret-at-least-thirty-two-bytes",
      AUTH_IDENTITY_PEPPER: "identity-pepper-at-least-thirty-two-bytes",
    } as const;
    await Promise.all(Object.entries(values).map(([name, value]) => writeFile(join(root, name), value, { mode: 0o600 })));
    const bindings = readNodeSecretBindings({
      AUTH_MODE: "wechat",
      WECHAT_OPEN_SECRET_FILE: join(root, "WECHAT_OPEN_SECRET"),
      SESSION_SECRET_FILE: join(root, "SESSION_SECRET"),
      AUTH_IDENTITY_PEPPER_FILE: join(root, "AUTH_IDENTITY_PEPPER"),
    }, { secretRoot: root, effectiveUid: process.geteuid?.() });
    assert.deepEqual(bindings, values);
    assert.throws(() => readNodeSecretBindings({ AUTH_MODE: "wechat", WECHAT_OPEN_SECRET: values.WECHAT_OPEN_SECRET }, { secretRoot: root, effectiveUid: process.geteuid?.() }), /WECHAT_OPEN_SECRET_MUST_USE_FILE/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Node Web secret loading is disabled with the internal API and rejects ambiguous or unsafe files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-node-secrets-unsafe-"));
  const root = join(parent, "secrets");
  try {
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, "hmac"), CURRENT_SECRET, { mode: 0o600 });
    assert.deepEqual(
      readNodeSecretBindings({ GENERATION_INTERNAL_CURRENT_SECRET_FILE: join(root, "hmac") }, { secretRoot: root }),
      {},
    );
    assert.throws(
      () => readNodeSecretBindings({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_CURRENT_SECRET_FILE: join(root, "hmac"),
        GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
      }, { secretRoot: root, effectiveUid: process.geteuid?.() }),
      /GENERATION_INTERNAL_CURRENT_SECRET_AMBIGUOUS/u,
    );
    assert.throws(
      () => readNodeSecretBindings({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
        GENERATION_INTERNAL_TICKET_SECRET: TICKET_SECRET,
      }, { secretRoot: root, effectiveUid: process.geteuid?.() }),
      /GENERATION_INTERNAL_CURRENT_SECRET_MUST_USE_FILE/u,
    );
    assert.throws(
      () => readNodeSecretBindings({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_CURRENT_SECRET_FILE: join(root, "hmac"),
      }, { secretRoot: root, effectiveUid: process.geteuid?.() }),
      /GENERATION_INTERNAL_TICKET_SECRET_FILE_REQUIRED/u,
    );

    await writeFile(join(parent, "outside"), TICKET_SECRET, { mode: 0o600 });
    assert.throws(
      () => readNodeSecretBindings({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_CURRENT_SECRET_FILE: join(root, "hmac"),
        GENERATION_INTERNAL_TICKET_SECRET_FILE: join(parent, "outside"),
      }, { secretRoot: root, effectiveUid: process.geteuid?.() }),
      /GENERATION_INTERNAL_TICKET_SECRET_FILE_OUTSIDE_SECRET_ROOT/u,
    );

    await symlink(join(root, "hmac"), join(root, "link"));
    assert.throws(
      () => readNodeSecretBindings({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_CURRENT_SECRET_FILE: join(root, "link"),
      }, { secretRoot: root, effectiveUid: process.geteuid?.() }),
      /GENERATION_INTERNAL_CURRENT_SECRET_FILE_UNSAFE/u,
    );

    await writeFile(join(root, "public"), TICKET_SECRET, { mode: 0o644 });
    assert.throws(
      () => readNodeSecretBindings({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_CURRENT_SECRET_FILE: join(root, "hmac"),
        GENERATION_INTERNAL_TICKET_SECRET_FILE: join(root, "public"),
      }, { secretRoot: root, effectiveUid: process.geteuid?.() }),
      /GENERATION_INTERNAL_TICKET_SECRET_FILE_UNSAFE/u,
    );
    await writeFile(join(root, "executable"), TICKET_SECRET, { mode: 0o700 });
    assert.throws(
      () => readNodeSecretBindings({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_CURRENT_SECRET_FILE: join(root, "hmac"),
        GENERATION_INTERNAL_TICKET_SECRET_FILE: join(root, "executable"),
      }, { secretRoot: root, effectiveUid: process.geteuid?.() }),
      /GENERATION_INTERNAL_TICKET_SECRET_FILE_UNSAFE/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("email mode loads the existing session/pepper and 16-character SMTP code from protected files only", async () => {
  const root = await mkdtemp(join(tmpdir(), "zaoshi-email-secrets-"));
  try {
    for (const [name, value] of Object.entries({ session: CURRENT_SECRET, pepper: TICKET_SECRET, smtp: "smtpcode012345678" })) await writeFile(join(root, name), value, { mode: 0o600 });
    const environment = { AUTH_MODE: "email", SESSION_SECRET_FILE: join(root, "session"), AUTH_IDENTITY_PEPPER_FILE: join(root, "pepper"), SMTP_AUTH_CODE_FILE: join(root, "smtp") };
    const dependencies = { secretRoot: root, effectiveUid: process.geteuid?.() };
    assert.deepEqual(readNodeSecretBindings(environment, dependencies), { SESSION_SECRET: CURRENT_SECRET, AUTH_IDENTITY_PEPPER: TICKET_SECRET, SMTP_AUTH_CODE: "smtpcode012345678" });
    assert.throws(() => readNodeSecretBindings({ ...environment, SMTP_AUTH_CODE: "smtpcode012345678" }, dependencies), /SMTP_AUTH_CODE_AMBIGUOUS/u);
    await writeFile(join(root, "session"), "short-session-val", { mode: 0o600 });
    assert.throws(() => readNodeSecretBindings(environment, dependencies), /SESSION_SECRET_INVALID/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("formal image provider credentials use the same protected-file boundary without weakening auth", async () => {
  const root=await mkdtemp(join(tmpdir(),"zaoshi-public-provider-secrets-"));
  try {
    for(const [name,value] of Object.entries({session:CURRENT_SECRET,pepper:TICKET_SECRET,ark:"ark-key8",qwen:"qwen-key8"})) await writeFile(join(root,name),value,{mode:0o600});
    const environment={AUTH_MODE:"email",BACKEND_PROFILE:"cn-production",PUBLIC_IMAGE_GENERATION_ENABLED:"1",SESSION_SECRET_FILE:join(root,"session"),AUTH_IDENTITY_PEPPER_FILE:join(root,"pepper"),ARK_API_KEY_FILE:join(root,"ark"),DASHSCOPE_API_KEY_FILE:join(root,"qwen")};
    const dependencies={secretRoot:root,effectiveUid:process.geteuid?.()};
    const bindings=readNodeSecretBindings(environment,dependencies);assert.equal(bindings.ARK_API_KEY,"ark-key8");assert.equal(bindings.DASHSCOPE_API_KEY,"qwen-key8");assert.equal(bindings.SESSION_SECRET,CURRENT_SECRET);
    assert.throws(()=>readNodeSecretBindings({...environment,ARK_API_KEY:"direct-key"},dependencies),/ARK_API_KEY_AMBIGUOUS/u);
    assert.throws(()=>readNodeSecretBindings({...environment,ARK_API_KEY_FILE:undefined,ARK_API_KEY:"direct-key"},dependencies),/ARK_API_KEY_MUST_USE_FILE/u);
    await chmod(join(root,"qwen"),0o644);assert.throws(()=>readNodeSecretBindings(environment,dependencies),/DASHSCOPE_API_KEY_FILE_UNSAFE/u);await chmod(join(root,"qwen"),0o600);
    await symlink(join(root,"ark"),join(root,"link"));assert.throws(()=>readNodeSecretBindings({...environment,ARK_API_KEY_FILE:join(root,"link")},dependencies),/ARK_API_KEY_FILE_UNSAFE/u);
    await writeFile(join(root,"session"),"only16characters",{mode:0o600});assert.throws(()=>readNodeSecretBindings(environment,dependencies),/SESSION_SECRET_INVALID/u);
  }finally{await rm(root,{recursive:true,force:true});}
});


test("isolated email preview accepts only local session files with all external services disabled", async () => {
 const root=await mkdtemp(join(tmpdir(),"zaoshi-local-auth-"));
 try {
  await writeFile(join(root,"session"),CURRENT_SECRET,{mode:0o600});
  await writeFile(join(root,"pepper"),TICKET_SECRET,{mode:0o600});
  const environment={NODE_LOCAL_SECRET_ROOT:root,BACKEND_PROFILE:"sites-demo",AUTH_MODE:"email",PUBLIC_IMAGE_GENERATION_ENABLED:"0",GENERATION_INTERNAL_API_ENABLED:"0",TENCENT_MODERATION_ENABLED:"0",WECHAT_PAY_ENABLED:"0",SESSION_SECRET_FILE:join(root,"session"),AUTH_IDENTITY_PEPPER_FILE:join(root,"pepper")};
  assert.deepEqual(readNodeSecretBindings(environment),{SESSION_SECRET:CURRENT_SECRET,AUTH_IDENTITY_PEPPER:TICKET_SECRET});
  for(const [name,value] of Object.entries({BACKEND_PROFILE:"cn-production",PUBLIC_IMAGE_GENERATION_ENABLED:"1",GENERATION_INTERNAL_API_ENABLED:"1",TENCENT_MODERATION_ENABLED:"1",WECHAT_PAY_ENABLED:"1",SMTP_AUTH_CODE_FILE:join(root,"smtp")})) assert.throws(()=>readNodeSecretBindings({...environment,[name]:value}),/ISOLATION_REQUIRED/);
 } finally {await rm(root,{recursive:true,force:true});}
});


test("payment loader validates real multiline RSA PEM files without weakening ordinary secrets", async()=>{
 const root=await mkdtemp(join(tmpdir(),"zaoshi-pem-"));
 try {
  const keys=generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
  for(const [name,value] of Object.entries({private:keys.privateKey,public:keys.publicKey,api:"a".repeat(32)})) await writeFile(join(root,name),value,{mode:0o600});
  const environment={WECHAT_PAY_ENABLED:"1",WECHAT_PAY_PRIVATE_KEY_FILE:join(root,"private"),WECHAT_PAY_PUBLIC_KEY_FILE:join(root,"public"),WECHAT_PAY_API_V3_KEY_FILE:join(root,"api")};
  const bindings=readNodeSecretBindings(environment,{secretRoot:root});
  assert.equal(bindings.WECHAT_PAY_PRIVATE_KEY,keys.privateKey.trim());assert.equal(bindings.WECHAT_PAY_PUBLIC_KEY,keys.publicKey.trim());
  await writeFile(join(root,"api"),"a".repeat(32)+"\ninvalid");assert.throws(()=>readNodeSecretBindings(environment,{secretRoot:root}),/API_V3_KEY_INVALID/);
  await writeFile(join(root,"public"),"invalid".repeat(10));assert.throws(()=>readNodeSecretBindings({...environment,WECHAT_PAY_API_V3_KEY_FILE:undefined},{secretRoot:root}),/FILE_REQUIRED|INVALID/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("additional WeChat login in email mode requires canonical protected secret and forbids aliases",async()=>{
 const root=await mkdtemp(join(tmpdir(),"zaoshi-website-secret-"));
 try {
  const names=["WECHAT_OPEN_SECRET","SESSION_SECRET","AUTH_IDENTITY_PEPPER"];
  for(const name of names)await writeFile(join(root,name),name.repeat(3),{mode:0o600});
  const env={AUTH_MODE:"email",WECHAT_LOGIN_ENABLED:"1",WECHAT_OPEN_SECRET_FILE:join(root,names[0]),SESSION_SECRET_FILE:join(root,names[1]),AUTH_IDENTITY_PEPPER_FILE:join(root,names[2])};
  assert.equal(readNodeSecretBindings(env,{secretRoot:root}).WECHAT_OPEN_SECRET,names[0].repeat(3));
  assert.throws(()=>readNodeSecretBindings({...env,WECHAT_OPEN_SECRET_FILE:undefined},{secretRoot:root}),/WECHAT_OPEN_SECRET_FILE_REQUIRED/);
  assert.throws(()=>readNodeSecretBindings({...env,WECHAT_OPEN_APP_SECRET:"must-not-bypass"},{secretRoot:root}),/CANONICAL_FILE_REQUIRED/);
  assert.throws(()=>readNodeSecretBindings({...env,WECHAT_OPEN_APP_SECRET_FILE:join(root,names[0])},{secretRoot:root}),/CANONICAL_FILE_REQUIRED/);
 }finally{await rm(root,{recursive:true,force:true});}
});
