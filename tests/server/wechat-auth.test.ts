import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";
import { completeWechatLogin, resolveWechatSessionActor, revokeWechatSession, startWechatLogin } from "../../lib/server/wechat-auth";
import type { WechatAuthConfig } from "../../lib/server/wechat-auth-config-core";

const config: WechatAuthConfig = {
  mode: "wechat",
  appId: "wx-test-app",
  secret: "wechat-secret-material".repeat(2),
  redirectUri: "https://zaoshi.example.test/api/auth/wechat/callback",
  sessionSecret: "session-secret-material".repeat(2),
  identityPepper: "identity-pepper-material".repeat(2),
};

function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  applyMigrations(database);
  return { database, d1: new TestD1Database(database) as unknown as D1Database };
}

function cookieValue(header: string, name: string): string {
  const match = header.match(new RegExp(`${name}=([^;,]+)`, "u"));
  assert.ok(match);
  return `${name}=${match[1]}`;
}

test("wechat OAuth state is browser-bound, one-time, and creates a persistent session", async () => {
  const { database, d1 } = setup();
  const start = await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start?returnTo=/profile"), config, d1);
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get("location")!);
  assert.equal(location.origin, "https://open.weixin.qq.com");
  assert.equal(location.searchParams.get("scope"), "snsapi_login");
  assert.equal(location.searchParams.get("redirect_uri"), config.redirectUri);
  const state = location.searchParams.get("state");
  assert.match(state!, /^[A-Za-z0-9_-]{43}$/u);
  const oauthCookie = cookieValue(start.headers.get("set-cookie")!, "__Host-zaoshi_oauth");

  const seen: URL[] = [];
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = new URL(input instanceof URL ? input : String(input));
    seen.push(url);
    if (url.pathname.endsWith("/access_token")) return Response.json({ access_token: "provider-access-token", openid: "raw-open-id", unionid: "raw-union-id" });
    return Response.json({ nickname: " 曹\u0000设计师 ", unionid: "raw-union-id" });
  }) as typeof fetch;
  const callbackUrl = `https://zaoshi.example.test/api/auth/wechat/callback?code=one-time-code&state=${encodeURIComponent(state!)}`;
  const callback = await completeWechatLogin(new Request(callbackUrl, { headers: { cookie: oauthCookie } }), config, d1, fetcher);
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "https://zaoshi.example.test/consent?returnTo=%2Fprofile");
  assert.deepEqual(seen.map((url) => url.origin), ["https://api.weixin.qq.com", "https://api.weixin.qq.com"]);
  const sessionCookie = cookieValue(callback.headers.get("set-cookie")!, "__Host-zaoshi_session");
  const actor = await resolveWechatSessionActor(new Request("https://zaoshi.example.test/api/me", { headers: { cookie: sessionCookie } }), config, d1);
  assert.equal(actor?.user.authenticated, true);
  assert.equal(actor?.user.displayName, "曹设计师");
  assert.match(actor?.ownerId ?? "", /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{8}$/u);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()?.count, 1);
  const persisted = JSON.stringify(database.prepare("SELECT * FROM auth_identities").all());
  assert.doesNotMatch(persisted, /raw-open-id|raw-union-id|provider-access-token|one-time-code/u);
  await assert.rejects(completeWechatLogin(new Request(callbackUrl, { headers: { cookie: oauthCookie } }), config, d1, fetcher), (error: unknown) => error instanceof Error && "code" in error && error.code === "OAUTH_STATE_INVALID");
  database.close();
});

test("wechat OAuth rejects another browser, external return paths, and revoked sessions", async () => {
  const { database, d1 } = setup();
  const start = await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start?returnTo=https://evil.example/"), config, d1);
  const location = new URL(start.headers.get("location")!);
  const callbackUrl = `https://zaoshi.example.test/api/auth/wechat/callback?code=code&state=${location.searchParams.get("state")}`;
  await assert.rejects(completeWechatLogin(new Request(callbackUrl, { headers: { cookie: "__Host-zaoshi_oauth=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }), config, d1, async () => Response.json({}) as never), (error: unknown) => error instanceof Error && "code" in error && error.code === "OAUTH_STATE_INVALID");
  const oauthCookie = cookieValue(start.headers.get("set-cookie")!, "__Host-zaoshi_oauth");
  let calls = 0;
  const fetcher = (async () => Response.json(++calls === 1 ? { access_token: "token", openid: "openid" } : { nickname: "微信用户" })) as typeof fetch;
  const callback = await completeWechatLogin(new Request(callbackUrl, { headers: { cookie: oauthCookie } }), config, d1, fetcher);
  assert.equal(callback.headers.get("location"), "https://zaoshi.example.test/consent?returnTo=%2Fprofile");
  const sessionCookie = cookieValue(callback.headers.get("set-cookie")!, "__Host-zaoshi_session");
  const request = new Request("https://zaoshi.example.test/api/auth/logout", { method: "POST", headers: { cookie: sessionCookie } });
  const logout = await revokeWechatSession(request, config, d1);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/u);
  assert.equal(await resolveWechatSessionActor(new Request("https://zaoshi.example.test/api/me", { headers: { cookie: sessionCookie } }), config, d1), null);
  database.close();
});

test("wechat OAuth rejects backslash redirects and never trusts the request host", async () => {
  const { database, d1 } = setup();
  const start = await startWechatLogin(new Request("https://attacker.example/api/auth/wechat/start?returnTo=/%5Cevil.example"), config, d1);
  const location = new URL(start.headers.get("location")!);
  const oauthCookie = cookieValue(start.headers.get("set-cookie")!, "__Host-zaoshi_oauth");
  let calls = 0;
  const fetcher = (async () => Response.json(++calls === 1 ? { access_token: "token", openid: "openid" } : { nickname: "微信用户" })) as typeof fetch;
  const response = await completeWechatLogin(
    new Request(`https://attacker.example/api/auth/wechat/callback?code=code&state=${location.searchParams.get("state")}`, { headers: { cookie: oauthCookie } }),
    config,
    d1,
    fetcher,
  );
  assert.equal(response.headers.get("location"), "https://zaoshi.example.test/consent?returnTo=%2Fprofile");
  database.close();
});

test("wechat OAuth rejects expired state and malformed provider responses", async () => {
  const { database, d1 } = setup();
  const start = await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start"), config, d1);
  const location = new URL(start.headers.get("location")!);
  const callbackUrl = `https://zaoshi.example.test/api/auth/wechat/callback?code=code&state=${location.searchParams.get("state")}`;
  const oauthCookie = cookieValue(start.headers.get("set-cookie")!, "__Host-zaoshi_oauth");
  database.exec("UPDATE auth_oauth_states SET expires_at = 0");
  await assert.rejects(
    completeWechatLogin(new Request(callbackUrl, { headers: { cookie: oauthCookie } }), config, d1, async () => Response.json({}) as never),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "OAUTH_STATE_INVALID",
  );

  const second = await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start"), config, d1);
  const secondLocation = new URL(second.headers.get("location")!);
  const secondUrl = `https://zaoshi.example.test/api/auth/wechat/callback?code=code&state=${secondLocation.searchParams.get("state")}`;
  const secondCookie = cookieValue(second.headers.get("set-cookie")!, "__Host-zaoshi_oauth");
  await assert.rejects(
    completeWechatLogin(
      new Request(secondUrl, { headers: { cookie: secondCookie } }),
      config,
      d1,
      async () => new Response("not-json", { headers: { "content-type": "application/json" } }) as never,
    ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "WECHAT_PROVIDER_INVALID",
  );
  database.close();
});

test("wechat OAuth keeps one pending state per browser and caps global pending writes", async () => {
  const { database, d1 } = setup();
  const first = await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start"), config, d1);
  assert.ok(new URL(first.headers.get("location")!).searchParams.get("state"));
  const firstStateHash = String(database.prepare("SELECT state_hash FROM auth_oauth_states").get()?.state_hash);
  const oauthCookie = cookieValue(first.headers.get("set-cookie")!, "__Host-zaoshi_oauth");
  await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start", { headers: { cookie: oauthCookie } }), config, d1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM auth_oauth_states WHERE consumed_at IS NULL").get()?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM auth_oauth_states WHERE state_hash = ?").get(firstStateHash)?.count, 0);

  database.exec(`WITH RECURSIVE sequence(value) AS (
    SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000
  ) INSERT INTO auth_oauth_states (state_hash, browser_nonce_hash, return_path, expires_at)
    SELECT printf('state-%04d', value), printf('browser-%04d', value), '/profile', unixepoch() + 600 FROM sequence`);
  await assert.rejects(
    startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start"), config, d1),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTH_RATE_LIMITED",
  );
  database.close();
});

test("suspending a user immediately invalidates an existing session", async () => {
  const { database, d1 } = setup();
  const start = await startWechatLogin(new Request("https://zaoshi.example.test/api/auth/wechat/start"), config, d1);
  const location = new URL(start.headers.get("location")!);
  const oauthCookie = cookieValue(start.headers.get("set-cookie")!, "__Host-zaoshi_oauth");
  let calls = 0;
  const fetcher = (async () => Response.json(++calls === 1 ? { access_token: "token", openid: "openid" } : { nickname: "微信用户" })) as typeof fetch;
  const callback = await completeWechatLogin(
    new Request(`https://zaoshi.example.test/api/auth/wechat/callback?code=code&state=${location.searchParams.get("state")}`, { headers: { cookie: oauthCookie } }),
    config,
    d1,
    fetcher,
  );
  const sessionCookie = cookieValue(callback.headers.get("set-cookie")!, "__Host-zaoshi_session");
  database.exec("UPDATE users SET status = 'SUSPENDED'");
  assert.equal(await resolveWechatSessionActor(new Request("https://zaoshi.example.test/api/me", { headers: { cookie: sessionCookie } }), config, d1), null);
  database.close();
});

test("concurrent WeChat subject callbacks reuse a single real eight-character account without orphan users",async()=>{
 const {database,d1}=setup();try{
  const requests=await Promise.all(['first','second'].map(async browser=>{
   const start=await startWechatLogin(new Request('https://zaoshi.example.test/api/auth/wechat/start',{headers:{cookie:`__Host-zaoshi_oauth=${browser.repeat(20)}`}}),config,d1);
   const state=new URL(start.headers.get('location')!).searchParams.get('state')!;
   return new Request(`https://zaoshi.example.test/api/auth/wechat/callback?code=${browser}&state=${state}`,{headers:{cookie:cookieValue(start.headers.get('set-cookie')!,'__Host-zaoshi_oauth')}});
  }));
  const fetcher:typeof fetch=async input=>String(input).includes('/access_token')?Response.json({access_token:'token',openid:'same-subject'}):Response.json({nickname:'same user'});
  const responses=await Promise.all(requests.map(request=>completeWechatLogin(request,config,d1,fetcher)));assert.deepEqual(responses.map(response=>response.status),[303,303]);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM users').get()?.n,1);assert.equal(database.prepare('SELECT COUNT(*) n FROM auth_identities').get()?.n,1);assert.equal(database.prepare('SELECT COUNT(*) n FROM user_generation_limits').get()?.n,1);assert.equal(database.prepare('SELECT COUNT(DISTINCT user_id) n FROM auth_sessions').get()?.n,1);assert.match(String(database.prepare('SELECT id FROM users').get()?.id),/^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{8}$/u);assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{database.close();}
});
