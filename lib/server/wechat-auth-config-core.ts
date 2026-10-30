export type AuthMode = "demo" | "wechat" | "private-test" | "email";
export interface WechatAuthConfig { mode: AuthMode; enabled?: boolean; appId?: string; secret?: string; redirectUri?: string; sessionSecret?: string; identityPepper?: string; }
export function resolveWechatAuthConfig(bindings: Record<string, unknown>): WechatAuthConfig {
 const value=(name:string)=>typeof bindings[name]==="string"&&String(bindings[name]).trim()?String(bindings[name]).trim():undefined;
 const configuredMode=value("AUTH_MODE"),mode=configuredMode==="wechat"||configuredMode==="private-test"||configuredMode==="email"?configuredMode:"demo";
 return {mode,enabled:mode==="wechat"||(mode==="email"&&value("WECHAT_LOGIN_ENABLED")==="1"),appId:value("WECHAT_OPEN_APP_ID"),secret:value("WECHAT_OPEN_SECRET"),redirectUri:value("WECHAT_OPEN_REDIRECT_URI")??value("WECHAT_REDIRECT_URI"),sessionSecret:value("SESSION_SECRET"),identityPepper:value("AUTH_IDENTITY_PEPPER")};
}
export function validateWechatAuthConfig(config: WechatAuthConfig): boolean {
 if(!(config.enabled??config.mode==="wechat")||!config.appId||!config.secret||!config.sessionSecret||!config.identityPepper||!config.redirectUri||config.sessionSecret.length<32||config.identityPepper.length<32||config.sessionSecret===config.identityPepper)return false;
 try{const url=new URL(config.redirectUri);return url.protocol==="https:"&&!url.username&&!url.password&&!url.hash&&!url.search;}catch{return false;}
}
export function wechatAuthStatus(config: WechatAuthConfig): {code:string;message:string} { if(!(config.enabled??config.mode==="wechat"))return {code:"AUTH_DISABLED",message:config.mode==="demo"?"演示环境未启用真实登录。":"微信登录暂未开放。"};if(!validateWechatAuthConfig(config))return {code:"WECHAT_AUTH_NOT_CONFIGURED",message:"微信登录尚未配置。"};return {code:"WECHAT_AUTH_READY",message:"微信登录已配置。"}; }
export function wechatAuthFailureResponse(config: WechatAuthConfig): Response { const status=wechatAuthStatus(config); return Response.json({error:status},{status:503,headers:{"Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'","X-Frame-Options":"DENY"}}); }

/** Pass the exact enabled website into the transaction; never infer it from user data. */
export function activeVerifiedIdentityPolicy(bindings: Record<string, unknown>): { requireActiveVerifiedIdentity: true; wechatAppId?: string } {
 const config=resolveWechatAuthConfig(bindings);
 return {requireActiveVerifiedIdentity:true,...(validateWechatAuthConfig(config)?{wechatAppId:config.appId}:{})};
}
