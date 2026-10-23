"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import Image from "next/image";
import { QRCodeSVG } from "qrcode.react";
import { getClientSession,loadSession,requireClientAccess,useSession } from "@/components/site/session";
import type { NativeOrder } from "@/src/contracts";
const packs=[{code:"CNY20",yuan:20,credits:2000,bonus:0},{code:"CNY50",yuan:50,credits:5100,bonus:2},{code:"CNY100",yuan:100,credits:10500,bonus:5},{code:"CNY200",yuan:200,credits:21400,bonus:7},{code:"CNY500",yuan:500,credits:55000,bonus:10}];
type Pending={idempotencyKey:string;productCode:string;orderId?:string};
type MemoryPending={pending?:Pending;dirty:boolean;ignoredKey?:string};
const memoryPending=new Map<string,MemoryPending>();
const walletRefreshes=new Map<string,Promise<void>|"done">();
function saved(scope:string):Pending|undefined {
 const memory=memoryPending.get(scope);let raw:string|null;
 try{raw=localStorage.getItem(`zaoshi:recharge:${scope}`);}catch(error){if(memory?.pending)return memory.pending;throw error;}
 let value:Pending|null=null;try{value=JSON.parse(raw??"null") as Pending|null;}catch{value=null;}
 const pending=value&&typeof value.idempotencyKey==="string"&&/^[A-Za-z0-9._:@-]{1,128}$/.test(value.idempotencyKey)&&packs.some(pack=>pack.code===value.productCode)&&value.idempotencyKey!==memory?.ignoredKey?value:undefined;
 if(memory?.dirty&&memory.pending){
  if(pending&&pending.idempotencyKey!==memory.pending.idempotencyKey){memoryPending.set(scope,{pending,dirty:false,ignoredKey:memory.ignoredKey});throw new Error("其他页面已有不同充值请求，请先确认原订单，暂勿重复充值。");}
  return memory.pending;
 }
 memoryPending.set(scope,{pending,dirty:false,ignoredKey:memory?.ignoredKey});return pending;
}
function Packs({enabled,busy=false,onChoose}:{enabled:boolean;busy?:boolean;onChoose:(code:string)=>void}){return <div className="recharge-cards">{packs.map(pack=><article key={pack.code} className={`recharge-card${pack.yuan===50?" featured":""}`}><span className={`recharge-bonus${pack.bonus?"":" recharge-start"}`}>{pack.bonus?`赠送 ${pack.bonus}%`:"轻松开始"}</span><h3>¥{pack.yuan}</h3><div className="recharge-original">{pack.bonus>0&&<del>{(pack.yuan*100).toLocaleString()} 积分</del>}</div><strong>{pack.credits.toLocaleString()}<small> 积分</small></strong><button className="secondary-button" disabled={!enabled||busy} onClick={()=>onChoose(pack.code)}>{!enabled?"暂未开放":busy?"正在确认…":"微信支付"}</button></article>)}</div>;}
export function RechargePanel(){const session=useSession();const [enabled,setEnabled]=useState(false);useEffect(()=>{const abort=new AbortController();fetch("/api/recharge/catalog",{signal:abort.signal}).then(response=>response.json()).then(data=>setEnabled(data.enabled===true)).catch(()=>setEnabled(false));return()=>abort.abort();},[]);return <>{session?.user.authenticated?<Checkout key={session.draftScope} scope={session.draftScope} enabled={enabled}/>:<Packs enabled={enabled} onChoose={()=>{requireClientAccess();}}/>}<p className="summary-note">{enabled?"微信扫码支付。付款确认后积分到账，可在此查询同一订单。":"充值暂未开放，以上套餐仅供预览。"}</p></>;}
function Checkout({scope,enabled}:{scope:string;enabled:boolean}){
 const [pending,setPending]=useState<Pending|undefined>(()=>{try{return saved(scope);}catch{return undefined;}}),[order,setOrder]=useState<NativeOrder>(),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[now,setNow]=useState(()=>Math.floor(Date.now()/1000));
 const [storageWarning,setStorageWarning]=useState(()=>!memoryPending.has(scope));const controller=useRef<AbortController|undefined>(undefined);
 const save=useCallback((next:Pending|undefined,expectedKey:string|undefined):"saved"|"memory"|"changed"=>{
  let current:Pending|undefined;try{current=saved(scope);}catch(error){
   setStorageWarning(true);setPending(memoryPending.get(scope)?.pending);setOrder(undefined);setMessage(error instanceof Error?error.message:"浏览器无法读取原订单，请恢复存储后重试。");return "changed";
  }
  if(current?.idempotencyKey!==expectedKey){setPending(current);setOrder(undefined);setMessage(current?"其他页面已更新充值订单，请查询当前订单，暂勿重复充值。":"原订单已在其他页面更新，请重新确认后再充值。");return "changed";}
  const previous=memoryPending.get(scope),memory={pending:next,dirty:true,ignoredKey:next?previous?.ignoredKey:expectedKey??previous?.ignoredKey};
  memoryPending.set(scope,memory);setPending(next);
  try{if(next)localStorage.setItem(`zaoshi:recharge:${scope}`,JSON.stringify(next));else localStorage.removeItem(`zaoshi:recharge:${scope}`);memory.dirty=false;setStorageWarning(false);return "saved";}catch{setStorageWarning(true);return "memory";}
 },[scope]);
 const apply=useCallback((next:NativeOrder,expected:Pending|undefined)=>{
  if(getClientSession()?.draftScope!==scope)return false;
  const owned=save(expected?{...expected,orderId:next.id}:undefined,expected?.idempotencyKey)!=="changed"&&Boolean(expected);
  if(owned)setOrder(next);
  if(next.status==="CREDITED"){
   if(owned)setMessage("支付已确认，积分已到账。");const key=`${scope}:${next.id}`;
   if(!walletRefreshes.has(key)){
    const refresh=Promise.resolve().then(()=>loadSession(true,{preserveOnTransientFailure:true})).then(session=>{
     if(!session.user.authenticated||session.draftScope!==scope)throw new Error("账户状态已变化，请重新登录后查询原订单。");
     walletRefreshes.set(key,"done");save(undefined,expected?.idempotencyKey);
    }).catch(()=>{
     walletRefreshes.delete(key);
     if(getClientSession()?.draftScope===scope)setMessage("支付已确认，账户信息刷新失败，请查询同一订单重试，或刷新页面恢复。");
    });walletRefreshes.set(key,refresh);
   }
  }else if(owned&&next.reconciliation)setMessage("支付需要进一步核对，请联系客服处理；暂未增加积分。");
  return owned;
 },[scope,save]);
 const query=useCallback(async(id:string)=>{const receipt=memoryPending.get(scope)?.pending,expected=receipt?.orderId===id?receipt:undefined;controller.current?.abort();const abort=new AbortController();controller.current=abort;try{const response=await fetch(`/api/recharge/orders/${encodeURIComponent(id)}`,{signal:abort.signal,cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(data.error?.message??"订单查询暂不可用。");if(!abort.signal.aborted){const owned=apply(data.order,expected);if(owned&&data.queryPending)setMessage("微信支付状态暂未确认，请稍后查询同一订单。");}}catch(error){if(!abort.signal.aborted&&getClientSession()?.draftScope===scope)setMessage(error instanceof Error?error.message:"订单仍待确认，请稍后查询。");}},[apply,scope]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Math.floor(Date.now()/1000)),1000);return()=>{clearInterval(timer);controller.current?.abort();};},[]);
 useEffect(()=>{const id=pending?.orderId;if(!id)return;const timer=setTimeout(()=>{void query(id);},0);return()=>clearTimeout(timer);},[pending?.orderId,query]);
 const pollId=order?.id,pollStatus=order?.status,pollExpires=order?.expiresAt,pollReconciliation=order?.reconciliation;
 useEffect(()=>{if(!pollId||pollStatus!=="PENDING"||pollReconciliation||!pollExpires||pollExpires<=Math.floor(Date.now()/1000))return;let attempts=0;const timer=setInterval(()=>{if(pollExpires<=Math.floor(Date.now()/1000)){clearInterval(timer);return;}if(++attempts>60){clearInterval(timer);setMessage("自动查询已暂停，可手动查询同一订单。");return;}void query(pollId);},3000);return()=>clearInterval(timer);},[pollId,pollStatus,pollExpires,pollReconciliation,query]);
 async function checkout(productCode:string){
  if(!requireClientAccess()||!enabled||busy)return;setBusy(true);setMessage("");
  try{
   let previous:Pending|undefined;try{previous=saved(scope);}catch(error){setStorageWarning(true);setPending(memoryPending.get(scope)?.pending);setOrder(undefined);setMessage(error instanceof Error&&error.message.startsWith("其他页面")?error.message:"浏览器无法读取原订单，请恢复浏览器存储后重试，暂勿重复充值。");return;}
   if(previous){setPending(previous);if(order&&previous.orderId!==order.id)setOrder(undefined);}
   if(previous&&previous.productCode!==productCode){setMessage("请先查询并确认原订单，避免重复充值。");return;}
   const request=previous??{productCode,idempotencyKey:crypto.randomUUID()},stored=save(request,previous?.idempotencyKey);if(stored!=="saved"){if(stored==="memory")setMessage("浏览器无法保存充值请求，请恢复存储后重试；原请求标识已保留，本次未发送支付请求。");return;}
   const response=await fetch("/api/recharge/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)});const data=await response.json();if(getClientSession()?.draftScope!==scope)return;
   if(!response.ok){if(typeof data.error?.details?.orderId==="string")save({...request,orderId:data.error.details.orderId},request.idempotencyKey);throw new Error(data.error?.message??"支付请求尚未确认，请查询原订单。");}apply(data.order,request);
  }catch(error){if(getClientSession()?.draftScope===scope)setMessage(error instanceof Error?error.message:"请求结果尚未确认，请查询原订单。");}finally{setBusy(false);}
 }
  async function closeOrder(){if(!order||busy)return;const receipt=memoryPending.get(scope)?.pending,expected=receipt?.orderId===order.id?receipt:undefined;setBusy(true);setMessage("");controller.current?.abort();try{
  const response=await fetch(`/api/recharge/orders/${encodeURIComponent(order.id)}/close`,{method:"POST"});const data=await response.json();if(getClientSession()?.draftScope!==scope)return;
  if(!response.ok)throw new Error(data.error?.message??"订单关闭尚未确认，请查询同一订单。");const owned=apply(data.order,expected);
  if(owned&&(data.queryPending||data.order.status==="PENDING"))setMessage("订单关闭尚未确认，请稍后查询同一订单，暂勿重复充值。");
 }catch(error){if(getClientSession()?.draftScope===scope)setMessage(error instanceof Error?error.message:"订单关闭尚未确认，请查询同一订单。");}finally{setBusy(false);}}
 function reset(){const expectedKey=pending?.orderId===order?.id?pending?.idempotencyKey:undefined;if(save(undefined,expectedKey)==="changed")return;setOrder(undefined);setMessage("原订单已确认关闭，可重新选择充值套餐。");}
 const expired=Boolean(order&&order.expiresAt<=now),showCode=Boolean(enabled&&order?.codeUrl&&order.status==="PENDING"&&!order.reconciliation&&!expired);
 return <><Packs enabled={enabled} busy={busy} onChoose={code=>void checkout(code)}/>{(order||pending)&&<section className={`native-checkout${order?.status==="CREDITED"?" is-credited":""}`} aria-label="微信充值订单">
  <div className="native-checkout-heading"><Image className="wechat-pay-logo" src="/demo/scene.svg" alt="微信支付" width={1152} height={468} unoptimized/><span>造室 · 积分充值</span></div>
  {order?.status==="CREDITED"?<><span className="native-success-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="m8 16 5 5 11-11" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg></span><h3>支付成功，积分已到账</h3><p className="native-credit-total">+{order.credits.toLocaleString()}<small> 积分</small></p></>:<><h3>{order?.reconciliation?"订单待核对":showCode?"微信扫码支付":"充值订单"}</h3>{order&&<div className="native-order-amount"><strong><small>¥</small>{(order.amountFen/100).toFixed(2)}</strong><span>到账 {order.credits.toLocaleString()} 积分</span></div>}</>}
  {showCode&&<div className="native-qr"><QRCodeSVG value={order!.codeUrl!} size={200} marginSize={4} fgColor="#000000" bgColor="#ffffff" title="使用微信扫描支付"/></div>}
  <p className="native-order-status">{order?.status==="CREDITED"?`实付 ¥${(order.amountFen/100).toFixed(2)} · 可继续你的空间创作`:order?.reconciliation?"支付需要进一步核对，暂未增加积分。请联系客服处理，勿重复付款。":order?.status==="CANCELED"?"原订单已确认关闭，可重新选择套餐。":order?.status==="EXPIRED"?"原订单已过期，微信确认未找到该订单，可重新选择套餐。":expired?"二维码已过期，订单状态仍需确认。":showCode?"演示二维码不能支付。请点击顶部「模拟付款成功」，再查询同一订单。":"正在核对原订单，暂不显示支付二维码。"}</p>
  <div className="native-checkout-actions">{order?.status==="CREDITED"&&<><a className="primary-button" href="/studio">开始设计</a><a className="secondary-button" href="/profile">查看积分</a></>}<button className="secondary-button" disabled={busy} onClick={()=>{if(order?.id)void query(order.id);else if(pending?.orderId)void query(pending.orderId);else if(pending)void checkout(pending.productCode);}}>查询同一订单</button>{order?.status==="PENDING"&&!order.reconciliation&&<button className="secondary-button" disabled={busy} onClick={()=>void closeOrder()}>取消订单 / 更换套餐</button>}{(order?.status==="CANCELED"||order?.status==="EXPIRED")&&!order.reconciliation&&<button className="secondary-button" disabled={busy} onClick={reset}>开始新的充值</button>}</div>
 </section>}{storageWarning&&<p className="summary-note" role="status">浏览器存储不可用，请保持本页并勿重复充值；恢复存储后可继续查询原订单。</p>}{message&&<p className="summary-note" role="status">{message}</p>}</>;
}
