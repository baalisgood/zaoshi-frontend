import { LEGAL_VERSION } from "../../lib/domain/legal";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { completeEmailAuth, createEmailCaptcha, sendEmailCode, resolveEmailAuthConfig, type EmailAction, type EmailAuthServices } from "../../lib/server/email-auth";
import { resolveStoredSessionActor, SESSION_COOKIE } from "../../lib/server/auth-session";
import { isSiteAdmin } from "../../lib/server/admin";
import { emailAuthServices } from "../../lib/server/email-auth-services";
const legal = { accepted: true, version: LEGAL_VERSION };
const config = { sessionSecret: "session-secret".repeat(4), identityPepper: "identity-pepper".repeat(4) };
const email = "owner@example.test", password = "correct password 123";
function setup() {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys=ON"); applyMigrations(database);
  const d1 = new TestD1Database(database) as unknown as D1Database;
  let answer = "", code = "", cookie = "";
  const services: EmailAuthServices = { captcha(value) { answer = value; return "<svg/>"; }, async send(_email, value) { code = value; } };
  const request = () => new Request("https://zaoshi.example.test/api/auth/email", { headers: { cookie } });
  async function captcha(action: EmailAction) {
    const response = await createEmailCaptcha(request(), action, d1, config, services);
    cookie = response.headers.get("set-cookie")!.split(";")[0]; const body = await response.json() as { id: string; svg: string };
    assert.equal(body.svg, "<svg/>"); assert.equal("answer" in body, false);
    return { captchaId: body.id, captchaAnswer: answer };
  }
  async function otp(purpose: "register" | "reset") {
    const cap = await captcha(`${purpose}-send`);
    const response = await sendEmailCode(request(), `${purpose}-send`, { legal, email, ...cap }, d1, config, services);
    return { challengeId: (await response.json() as { challengeId: string }).challengeId, code };
  }
  async function register() { const input = { legal, email, password, ...await otp("register"), ...await captcha("register") }; return completeEmailAuth(request(), "register", input, d1, config); }
  return { database, d1, request, captcha, otp, register, services };
}
const invalid = (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTH_INVALID";

test("verified email registers USER, reuses persistent session and trusted admin whitelist", async () => {
  const s = setup(); try {
    const response = await s.register(); const cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.match(cookie, /^__Host-zaoshi_session=/u); assert.match(response.headers.get("set-cookie")!, /HttpOnly; Secure; SameSite=Lax/u);
    const actor = await resolveStoredSessionActor(new Request("https://zaoshi.example.test/api/me", { headers: { cookie } }), config.sessionSecret, s.d1, SESSION_COOKIE, true);
    assert.equal(actor?.user.email, email); assert.equal(actor?.user.role, "USER"); assert.equal(actor?.trusted, true);
    assert.equal(isSiteAdmin(actor!, { ADMIN_EMAILS: email }), true); assert.equal(isSiteAdmin(actor!, {}), false);
    const credentials = JSON.stringify(s.database.prepare("SELECT * FROM auth_email_credentials").all()); assert.doesNotMatch(credentials, /correct password/u);
    assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM user_legal_acceptances").get()?.n, 2);
    assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM user_generation_limits").get()?.n, 1);
    assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM credit_ledger_entries").get()?.n, 1);
    assert.equal(s.database.prepare("SELECT SUM(amount) AS n FROM credit_ledger_entries").get()?.n, 350);
    const welcome=s.database.prepare("SELECT * FROM credit_ledger_entries").get()!;
    assert.equal(welcome.reason_code,"EMAIL_REGISTRATION_WELCOME");assert.equal(welcome.idempotency_key,"email-welcome-v1");assert.equal(welcome.actor_id,"system");
    assert.equal(s.database.prepare("SELECT email_registration_receipt FROM users").get()?.email_registration_receipt,welcome.request_id);
  } finally { s.database.close(); }
});
test("captcha purpose/browser/expiry, five guesses, and OTP replay never create an account", async () => {
  const s = setup(); try {
    const otp = await s.otp("register"), cap = await s.captcha("register");
    await assert.rejects(completeEmailAuth(new Request("https://zaoshi.example.test/api", { headers: { cookie: "__Host-zaoshi_auth=" + "A".repeat(43) } }), "register", { legal, email, password, ...otp, ...cap }, s.d1, config), invalid);
    const expired = await s.captcha("register"); s.database.prepare("UPDATE auth_email_challenges SET expires_at = 0 WHERE id = ?").run(expired.captchaId);
    await assert.rejects(completeEmailAuth(s.request(), "register", { legal, email, password, ...otp, ...expired }, s.d1, config), invalid);
    assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM users").get()?.n, 0);
    assert.equal(credits(s)?.n,0);
    for (let i = 0; i < 5; i++) await assert.rejects(completeEmailAuth(s.request(), "register", { legal, email, password, ...otp, ...cap, captchaAnswer: cap.captchaAnswer === "000000" ? "111111" : "000000" }, s.d1, config), invalid);
    await assert.rejects(completeEmailAuth(s.request(), "register", { legal, email, password, ...otp, ...cap }, s.d1, config), invalid);
    const valid = await s.captcha("register"); await completeEmailAuth(s.request(), "register", { legal, email, password, ...otp, ...valid }, s.d1, config);
    await assert.rejects(completeEmailAuth(s.request(), "register", { legal, email, password, ...otp, ...await s.captcha("register") }, s.d1, config), invalid);
    assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM users").get()?.n, 1);
  } finally { s.database.close(); }
});
test("wrong OTP attempts exhaust atomically and CAPTCHA from send cannot authorize registration", async () => {
  const s = setup(); try {
    const otp = await s.otp("register");
    await assert.rejects(completeEmailAuth(s.request(), "register", { legal, email, password, ...otp, ...await s.captcha("register-send") }, s.d1, config), invalid);
    for (let i = 0; i < 5; i++) await assert.rejects(completeEmailAuth(s.request(), "register", { legal, email, password, ...otp, code: otp.code === "000000" ? "111111" : "000000", ...await s.captcha("register") }, s.d1, config), invalid);
    await assert.rejects(completeEmailAuth(s.request(), "register", { legal, email, password, ...otp, ...await s.captcha("register") }, s.d1, config), invalid);
    assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM users").get()?.n, 0);
    assert.equal(credits(s)?.n,0);
  } finally { s.database.close(); }
});
test("reset revokes every session, consumes OTP once, and rejects old password", async (t) => {
  const s = setup(); try {
    const registration = await s.register(); const login = await completeEmailAuth(s.request(), "login", { legal, email, password, ...await s.captcha("login") }, s.d1, config);
    const later = Date.now() + 61_000; t.mock.method(Date, "now", () => later);
    const otp = await s.otp("reset"), newPassword = "new correct password 456";
    await completeEmailAuth(s.request(), "reset", { email, password: newPassword, ...otp, ...await s.captcha("reset") }, s.d1, config);
    assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL").get()?.n, 0);
    for (const response of [registration, login]) assert.equal(await resolveStoredSessionActor(new Request("https://zaoshi.example.test/api/me", { headers: { cookie: response.headers.get("set-cookie")!.split(";")[0] } }), config.sessionSecret, s.d1, SESSION_COOKIE, true), null);
    await assert.rejects(completeEmailAuth(s.request(), "reset", { email, password: newPassword, ...otp, ...await s.captcha("reset") }, s.d1, config), invalid);
    await assert.rejects(completeEmailAuth(s.request(), "login", { legal, email, password, ...await s.captcha("login") }, s.d1, config), invalid);
    assert.equal((await completeEmailAuth(s.request(), "login", { email, password: newPassword, ...await s.captcha("login") }, s.d1, config)).status, 200);
    assert.equal(credits(s)?.n,1);assert.equal(credits(s)?.amount,350);
  } finally { s.database.close(); }
});
test("password version guard blocks session insertion after concurrent reset", async () => {
  const s = setup(); try {
    await s.register(); const cap = await s.captcha("login");
    const original = s.d1.prepare.bind(s.d1);
    const racing = { ...s.d1, batch: s.d1.batch.bind(s.d1), prepare(sql: string) {
      const statement = original(sql);
      if (!sql.startsWith("SELECT user_id, password_hash, version")) return statement;
      return { bind(...values: unknown[]) { const bound = statement.bind(...values); return { async first() { const row = await bound.first(); s.database.prepare("UPDATE auth_email_credentials SET version = version + 1").run(); return row; } }; } };
    } } as unknown as D1Database;
    await assert.rejects(completeEmailAuth(s.request(), "login", { legal, email, password, ...cap }, racing, config), invalid);
    assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()?.n, 1);
  } finally { s.database.close(); }
});
test("send failure keeps code undelivered, cooldown persists, and missing SMTP fails closed", async () => {
  const s = setup(); try {
    const cap = await s.captcha("register-send");
    await assert.rejects(sendEmailCode(s.request(), "register-send", { legal, email, ...cap }, s.d1, config, { ...s.services, async send() { throw new Error("sensitive provider detail"); } }), (error: unknown) => error instanceof Error && !error.message.includes("sensitive") && "code" in error && error.code === "EMAIL_SEND_UNAVAILABLE");
    assert.equal(s.database.prepare("SELECT delivered FROM auth_email_challenges WHERE purpose = 'register'").get()?.delivered, 0);
    await assert.rejects(sendEmailCode(s.request(), "register-send", { legal, email, ...await s.captcha("register-send") }, s.d1, config, s.services), (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTH_RATE_LIMITED");
    assert.equal(resolveEmailAuthConfig({ AUTH_MODE: "email" }), null);
    assert.throws(() => emailAuthServices({ ZAOSHI_RUNTIME: "node" }), /尚未配置/u);
    const svg = emailAuthServices({ ZAOSHI_RUNTIME: "node", SMTP_SENDER: "public-test@163.com", SMTP_AUTH_CODE: "a".repeat(16) }).captcha("123456");
    assert.match(svg, /^<svg/u); assert.doesNotMatch(svg, /123456|<text|script|foreignObject/u);
  } finally { s.database.close(); }
});


test("unsolved CAPTCHA never starts expensive password derivation", async () => {
  const s = setup(); try {
    const otp = await s.otp("register"), cap = await s.captcha("register");
    const failures = await Promise.all(Array.from({ length: 3 }, () => completeEmailAuth(s.request(), "register", { legal, email, password, ...otp, ...cap, captchaAnswer: cap.captchaAnswer === "000000" ? "111111" : "000000" }, s.d1, config).catch(error => error)));
    for (const error of failures) assert.ok(invalid(error));
    assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM auth_email_credentials").get()?.n, 0);
  } finally { s.database.close(); }
});

test("global send quota blocks distributed email recipients before SMTP", async () => {
  const s = setup(); let sends = 0; s.services.send = async () => { sends += 1; };
  try {
    const { limitEmailAuth } = await import("../../lib/server/email-auth");
    for (let i = 0; i < 30; i++) await limitEmailAuth(s.d1, config, "global:send", 30, 3600);
    const cap = await s.captcha("register-send");
    await assert.rejects(sendEmailCode(s.request(), "register-send", { legal, email: "other@example.test", ...cap }, s.d1, config, s.services), (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTH_RATE_LIMITED");
    assert.equal(sends, 0);
  } finally { s.database.close(); }
});


test("unsolved CAPTCHA cannot exhaust another email's login or send budget", async () => {
  const s = setup(); try {
    await s.register();
    const cap = await s.captcha("login"), wrong = cap.captchaAnswer === "000000" ? "111111" : "000000";
    for (let i = 0; i < 10; i++) await assert.rejects(completeEmailAuth(s.request(), "login", { legal, email, password, ...cap, captchaAnswer: wrong }, s.d1, config), invalid);
    const own = await s.captcha("login");
    assert.equal((await completeEmailAuth(s.request(), "login", { legal, email, password, ...own }, s.d1, config)).status, 200);
    const sendCap = await s.captcha("reset-send"), other = "another@example.test";
    for (let i = 0; i < 6; i++) await assert.rejects(sendEmailCode(s.request(), "reset-send", { email: other, ...sendCap, captchaAnswer: sendCap.captchaAnswer === "000000" ? "111111" : "000000" }, s.d1, config, s.services), invalid);
    const valid = await s.captcha("reset-send");
    assert.equal((await sendEmailCode(s.request(), "reset-send", { email: other, ...valid }, s.d1, config, s.services)).status, 200);
  } finally { s.database.close(); }
});

test("registration refuses unchecked or obsolete consent before any account or challenge writes", async () => {
 const s=setup();try{
  for(const input of [undefined,{accepted:false,version:LEGAL_VERSION},{accepted:true,version:"old"}]){
   await assert.rejects(completeEmailAuth(s.request(),"register",{legal:input,email,password},s.d1,config), error=>error instanceof Error && "code" in error && error.code === "LEGAL_CONSENT_REQUIRED");
   await assert.rejects(sendEmailCode(s.request(),"register-send",{legal:input,email},s.d1,config,s.services), error=>error instanceof Error && "code" in error && error.code === "LEGAL_CONSENT_REQUIRED");
  }
  assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM users").get()?.n,0);
  assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM user_legal_acceptances").get()?.n,0);
  assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM auth_email_challenges").get()?.n,0);
 }finally{s.database.close();}
});

function credits(s: ReturnType<typeof setup>) { return s.database.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM credit_ledger_entries").get(); }
test("two valid captchas sharing one OTP register and credit exactly once; lost response then login retains balance", async () => {
 const s=setup();try{
  const otp=await s.otp("register"), first=await s.captcha("register"),second=await s.captcha("register");
  const results=await Promise.allSettled([first,second].map(cap=>completeEmailAuth(s.request(),"register",{legal,email,password,...otp,...cap},s.d1,config)));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(results.filter(r=>r.status==="rejected").length,1);
  assert.equal(credits(s)?.n,1);assert.equal(credits(s)?.amount,350);
  await completeEmailAuth(s.request(),"login",{email,password,...await s.captcha("login")},s.d1,config);
  assert.equal(credits(s)?.amount,350);
 }finally{s.database.close();}
});
test("expired, undelivered, wrong-browser and wrong-purpose OTPs never create welcome credit", async () => {
 for(const failure of ["expired","undelivered","browser","purpose"]){
  const s=setup();try{
   const otp=await s.otp("register"),cap=await s.captcha("register");
   if(failure==="expired")s.database.prepare("UPDATE auth_email_challenges SET expires_at=0 WHERE id=?").run(otp.challengeId);
   if(failure==="undelivered")s.database.prepare("UPDATE auth_email_challenges SET delivered=0 WHERE id=?").run(otp.challengeId);
   if(failure==="browser")s.database.prepare("UPDATE auth_email_challenges SET browser_hash='foreign' WHERE id=?").run(otp.challengeId);
   if(failure==="purpose")s.database.prepare("UPDATE auth_email_challenges SET purpose='reset' WHERE id=?").run(otp.challengeId);
   await assert.rejects(completeEmailAuth(s.request(),"register",{legal,email,password,...otp,...cap},s.d1,config),invalid);
   assert.equal(credits(s)?.n,0);assert.equal(s.database.prepare("SELECT COUNT(*) AS n FROM users").get()?.n,0);
  }finally{s.database.close();}
 }
});
test("existing account and preexisting deterministic identity receive no registration gift; suspended identity cannot authenticate", async () => {
 const {secretHash}=await import("../../lib/server/auth-session");
 for(const kind of ["old","active-no-credential","suspended-no-credential","suspended-credential"]){
  const s=setup();try{
   const userId=`user_${secretHash(config.identityPepper,`email:${email}`)}`;
   if(kind==="old"||kind==="suspended-credential"){
    s.database.prepare("INSERT INTO users (id,display_name) VALUES (?, 'existing')").run(userId);
    const {hashPassword}=await import("../../lib/server/email-auth");
    s.database.prepare("INSERT INTO auth_email_credentials (email,user_id,password_hash,verified_at) VALUES (?,?,?,unixepoch())").run(email,userId,await hashPassword(password));
   }else s.database.prepare("INSERT INTO users (id,display_name) VALUES (?, 'existing')").run(userId);
   if(kind.startsWith("suspended"))s.database.exec("UPDATE users SET status='SUSPENDED'");
   const otp=await s.otp("register").catch(()=>null);
   // The original send cooldown applies to preexisting credential scenarios.
   if(!otp){s.database.exec("DELETE FROM auth_email_rate_limits");}
   const challenge=otp??await s.otp("register");
   const attempt=completeEmailAuth(s.request(),"register",{legal,email,password,...challenge,...await s.captcha("register")},s.d1,config);
   if(kind!=="active-no-credential")await assert.rejects(attempt,invalid);else await attempt;
   assert.equal(credits(s)?.n,0);assert.equal(s.database.prepare("SELECT email_registration_receipt FROM users").get()?.email_registration_receipt,null);
   if(kind.startsWith("suspended")){for(const table of ["auth_sessions","auth_identities","user_generation_limits","user_legal_acceptances"])assert.equal(s.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,0);}
  }finally{s.database.close();}
 }
});
test("failure immediately before welcome credit rolls back registration OTP, user, credential, session and consent", async () => {
 const s=setup();try{
  const otp=await s.otp("register"),cap=await s.captcha("register");
  const failing=new TestD1Database(s.database, statement=>{if(statement.sqlText().startsWith("INSERT INTO credit_ledger_entries"))throw new Error("injected ledger failure");}) as unknown as D1Database;
  await assert.rejects(completeEmailAuth(s.request(),"register",{legal,email,password,...otp,...cap},failing,config),/injected ledger failure/);
  for(const table of ["users","auth_email_credentials","auth_sessions","auth_identities","user_generation_limits","user_legal_acceptances","credit_ledger_entries"])assert.equal(s.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,0);
  assert.equal(s.database.prepare("SELECT consumed_at FROM auth_email_challenges WHERE id=?").get(otp.challengeId)?.consumed_at,null);
  await completeEmailAuth(s.request(),"register",{legal,email,password,...otp,...await s.captcha("register")},s.d1,config);
  assert.equal(credits(s)?.amount,350);
 }finally{s.database.close();}
});

test("random user primary-key collision rolls back the whole registration batch and retries without binding another account",async()=>{
 const s=setup();try{
  const otp=await s.otp("register"),cap=await s.captcha("register");let collisions=0;let collidedId="";
  const d1=new TestD1Database(s.database,statement=>{
   if(statement.sqlText().startsWith('INSERT INTO users')&&collisions++===0){
    collidedId=String((statement as unknown as {values:unknown[]}).values[0]);
    s.database.prepare("INSERT INTO users(id,display_name,status) VALUES(?,'collision owner','SUSPENDED')").run(collidedId);
   }
  }) as unknown as D1Database;
  const response=await completeEmailAuth(s.request(),"register",{legal,email,password,...otp,...cap},d1,config);assert.equal(response.status,200);
  const user=s.database.prepare("SELECT id,status,identity_namespace FROM users").get()!;assert.match(String(user.id),/^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{8}$/u);assert.notEqual(user.id,collidedId);assert.equal(user.status,"ACTIVE");assert.equal(user.identity_namespace,user.id);
  assert.equal(s.database.prepare("SELECT COUNT(*) n FROM users").get()?.n,1);assert.equal(s.database.prepare("SELECT COUNT(*) n FROM credit_ledger_entries").get()?.n,1);assert.equal(s.database.prepare("SELECT SUM(amount) n FROM credit_ledger_entries").get()?.n,350);
 }finally{s.database.close();}
});

test('email invitation is attributed only at successful new registration and leaves future logins unchanged',async()=>{
 const s=setup();try{
  s.database.exec("INSERT INTO users(id,display_name) VALUES('PROMO001','P');INSERT INTO referral_promoters(user_id) VALUES('PROMO001')");
  const otp=await s.otp('register'),cap=await s.captcha('register');
  await completeEmailAuth(s.request(),'register',{legal,email,password,inviteCode:'PROMO001',...otp,...cap},s.d1,config);
  const row=s.database.prepare('SELECT * FROM user_referrals').get();assert.equal(row?.promoter_id,'PROMO001');
  assert.equal(s.database.prepare('SELECT active_concurrency_limit n FROM user_generation_limits WHERE owner_id=?').get(row!.invitee_id)?.n,3);
  const loginCap=await s.captcha('login');await completeEmailAuth(s.request(),'login',{email,password,inviteCode:'PROMO001',...loginCap},s.d1,config);
  assert.equal(s.database.prepare('SELECT COUNT(*) n FROM user_referrals').get()?.n,1);
 }finally{s.database.close();}
});
