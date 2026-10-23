"use client";
import { useState } from "react";
import { LEGAL_VERSION, safeReturnPath } from "@/lib/domain/legal";
import { loadSession, useSession } from "@/components/site/session";
import { responseMessage } from "@/components/site/api";
export function ConsentView() {
 const session = useSession(); const [checked,setChecked] = useState(false); const [busy,setBusy] = useState(false); const [message,setMessage] = useState("");
 async function accept() {
  if (!checked || busy) return;
  setBusy(true); setMessage("");
  try {
   const response = await fetch("/api/legal/accept",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accepted:true,version:LEGAL_VERSION})});
   if(!response.ok) throw new Error(await responseMessage(response,"确认失败，请重试。"));
   await loadSession(true);
   const target=new URLSearchParams(window.location.search).get("returnTo");
   window.location.assign(safeReturnPath(target, "/studio"));
  } catch(error) { setMessage(error instanceof Error ? error.message : "确认失败。"); } finally {setBusy(false);}
 }
 return <div className="page-shell consent-page"><span className="section-kicker">BEFORE YOU CREATE</span><h1>继续创作前，请确认服务条款</h1><p>请了解图片处理、AI结果限制及积分规则。你仍可查看已有任务与图片。</p><label className="legal-checkbox"><input type="checkbox" checked={checked} onChange={event=>setChecked(event.target.checked)} /><span>我已阅读并同意<a href="/terms" target="_blank" rel="noopener">用户协议</a>和<a href="/privacy" target="_blank" rel="noopener">隐私政策</a>。</span></label><p><a href="/usage">查看使用须知</a> · <a href="/recharge-policy">查看充值与退款说明</a></p>{session?.user.authenticated ? <button className="primary-button" disabled={!checked || busy} onClick={()=>void accept()}>{busy?"保存中…":"同意并继续"}</button>:<a className="primary-button" href="/login">先登录</a>}<p role="status">{message}</p></div>;
}
