import { createHash, createSign, createVerify, createDecipheriv, randomBytes } from "node:crypto";
import { ApiError } from "./api";
import { readBoundedResponseText } from "./bounded-response";

export type WechatPayConfig = { appId: string; mchId: string; serial: string; publicKeyId: string; privateKey: string; apiV3Key: string; publicKeys: Record<string, string>; notifyUrl: string };
export function wechatPayConfig(env: Record<string, unknown>): WechatPayConfig {
 const required = ["WECHAT_PAY_APP_ID","WECHAT_PAY_MCH_ID","WECHAT_PAY_MERCHANT_SERIAL","WECHAT_PAY_PRIVATE_KEY","WECHAT_PAY_API_V3_KEY","WECHAT_PAY_PUBLIC_KEY_ID","WECHAT_PAY_PUBLIC_KEY","WECHAT_PAY_NOTIFY_URL","SERVICE_OPERATOR_NAME","SERVICE_CONTACT"];
 if (env.WECHAT_PAY_ENABLED !== "1" || required.some(k => typeof env[k] !== "string" || !(env[k] as string).trim())) throw unavailable();
 const notify = new URL(String(env.WECHAT_PAY_NOTIFY_URL));
 if (notify.protocol !== "https:" || notify.username || notify.password || Buffer.byteLength(String(env.WECHAT_PAY_API_V3_KEY)) !== 32) throw unavailable();
 const keys: Record<string,string> = { [String(env.WECHAT_PAY_PUBLIC_KEY_ID)]: String(env.WECHAT_PAY_PUBLIC_KEY) };
 if (env.WECHAT_PAY_PREVIOUS_PUBLIC_KEY_ID && env.WECHAT_PAY_PREVIOUS_PUBLIC_KEY) keys[String(env.WECHAT_PAY_PREVIOUS_PUBLIC_KEY_ID)] = String(env.WECHAT_PAY_PREVIOUS_PUBLIC_KEY);
 return { appId: String(env.WECHAT_PAY_APP_ID), mchId: String(env.WECHAT_PAY_MCH_ID), serial: String(env.WECHAT_PAY_MERCHANT_SERIAL), publicKeyId: String(env.WECHAT_PAY_PUBLIC_KEY_ID), privateKey: String(env.WECHAT_PAY_PRIVATE_KEY), apiV3Key: String(env.WECHAT_PAY_API_V3_KEY), publicKeys: keys, notifyUrl: notify.href };
}
export function signWechatRequest(method: "POST"|"GET", path: string, body: string, config: WechatPayConfig, timestamp = Math.floor(Date.now()/1000), nonce = randomBytes(16).toString("hex")): string {
 const signature = createSign("RSA-SHA256").update(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`).sign(config.privateKey,"base64");
 return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.serial}",signature="${signature}"`;
}
export function verifyWechatMessage(raw: string, headers: Headers, config: WechatPayConfig, now = Math.floor(Date.now()/1000)): void {
 const timestamp = headers.get("Wechatpay-Timestamp") ?? "", nonce = headers.get("Wechatpay-Nonce") ?? "", serial = headers.get("Wechatpay-Serial") ?? "", signature = headers.get("Wechatpay-Signature") ?? "";
 const type = headers.get("Wechatpay-Signature-Type");
 if (!/^\d{10}$/.test(timestamp) || Math.abs(now-Number(timestamp))>300 || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce) || (type && type !== "WECHATPAY2-SHA256-RSA2048") || !config.publicKeys[serial] || signature.startsWith("WECHATPAY/SIGNTEST/") || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw invalid();
 if (!createVerify("RSA-SHA256").update(`${timestamp}\n${nonce}\n${raw}\n`).verify(config.publicKeys[serial], signature,"base64")) throw invalid();
}
export async function wechatRequest(method: "POST"|"GET", path: string, data: unknown, config: WechatPayConfig, transport: typeof fetch = fetch): Promise<Record<string,unknown>> {
 if (!path.startsWith("/v3/pay/transactions/") || /[\r\n]/.test(path)) throw invalid();
 const body = method === "POST" ? JSON.stringify(data) : "";
 const response = await transport(`https://api.mch.weixin.qq.com${path}`, { method, redirect: "error", signal: AbortSignal.timeout(15000), headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: signWechatRequest(method,path,body,config), "Wechatpay-Serial": config.publicKeyId }, ...(body ? {body} : {}) });
 const raw = response.status === 204 && response.body === null ? "" : await readBoundedResponseText(response,{maxBytes:65536,tooLargeCode:"PAYMENT_UNAVAILABLE",invalidCode:"PAYMENT_UNAVAILABLE",label:"支付服务"});
 verifyWechatMessage(raw,response.headers,config);
 if (response.status === 204 && raw === "" && method === "POST" && /^\/v3\/pay\/transactions\/out-trade-no\/[A-Za-z0-9_-]{1,32}\/close$/.test(path)) return {};
 let parsed:Record<string,unknown>;try { parsed=JSON.parse(raw); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid(); } catch { throw invalid(); }
 if(!response.ok){
  if(response.status===404&&method==="GET"&&path.startsWith("/v3/pay/transactions/out-trade-no/")&&parsed.code==="ORDER_NOT_EXIST")throw new ApiError(503,"WECHAT_ORDER_NOT_EXIST","微信未找到这笔支付订单。");
  throw unavailable();
 }
 return parsed;
}
export function decryptWechatResource(resource: unknown, config: WechatPayConfig): Record<string,unknown> {
 try {
  if (!resource || typeof resource !== "object") throw invalid();
  const r = resource as Record<string,unknown>;
  if (r.algorithm !== "AEAD_AES_256_GCM" || typeof r.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(r.ciphertext) || typeof r.nonce !== "string" || Buffer.byteLength(r.nonce)!==12 || (r.associated_data !== undefined && typeof r.associated_data !== "string")) throw invalid();
  const encrypted = Buffer.from(r.ciphertext,"base64"); if (encrypted.length<=16 || encrypted.toString("base64")!==r.ciphertext) throw invalid();
  const decipher = createDecipheriv("aes-256-gcm",Buffer.from(config.apiV3Key),Buffer.from(r.nonce));decipher.setAuthTag(encrypted.subarray(-16));decipher.setAAD(Buffer.from(String(r.associated_data ?? "")));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]); const parsed = JSON.parse(plain.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid(); return parsed;
 } catch { throw invalid(); }
}
export type PaymentFact = { orderId: string; transactionId: string; amountFen: number; paidAt: number; factsHash: string };
export function normalizePaymentFact(data: Record<string,unknown>, config: WechatPayConfig, now = Math.floor(Date.now()/1000)): PaymentFact {
 const amount = data.amount as Record<string,unknown> | undefined;
 if (data.appid !== config.appId || data.mchid !== config.mchId || data.trade_type !== "NATIVE" || data.trade_state !== "SUCCESS" || typeof data.out_trade_no !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(data.out_trade_no) || typeof data.transaction_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.transaction_id) || !Number.isSafeInteger(amount?.total) || Number(amount?.total)<=0 || amount?.currency !== "CNY" || typeof data.success_time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(data.success_time)) throw invalid();
 const paidAt = Date.parse(data.success_time)/1000;if (!Number.isSafeInteger(paidAt) || paidAt<=0 || paidAt>now) throw invalid();
 const facts = { orderId:data.out_trade_no, transactionId:data.transaction_id, amountFen:Number(amount.total),paidAt };
 return {...facts,factsHash:createHash("sha256").update(JSON.stringify({...facts,appId:config.appId,mchId:config.mchId,currency:"CNY"})).digest("hex")};
}
function invalid(): ApiError { return new ApiError(400,"INVALID_PAYMENT_MESSAGE","支付信息未通过校验。"); }
function unavailable(): ApiError { return new ApiError(503,"PAYMENT_UNAVAILABLE","充值暂未开放，请稍后重试。"); }
