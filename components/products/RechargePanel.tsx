"use client";
import { useCallback,useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { celebrate } from "./celebrate";
import { QRCodeSVG } from "qrcode.react";
import { getClientSession,loadSession,requireClientAccess,useSession } from "@/components/site/session";
import type { NativeOrder } from "@/lib/server/recharge-native-orders";
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
function WechatIcon(){return <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.4 3C4.8 3 1 6 1 9.7c0 2.1 1.2 4 3.2 5.2l-.8 2.4 2.8-1.4c.9.3 2 .5 3.2.5h.5a6.5 6.5 0 0 1-.7-2.9c0-3.5 3.3-6.3 7.3-6.3h.8C16 4.7 13 3 9.4 3ZM6.6 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5.7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/><path d="M16.5 8.4c-3.5 0-6.3 2.3-6.3 5.1s2.8 5.1 6.3 5.1c.9 0 1.7-.1 2.5-.4l2.2 1.1-.6-1.9c1.5-.9 2.4-2.3 2.4-3.9 0-2.8-2.9-5.1-6.5-5.1Zm-2.1 3.1a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Zm4.3 0a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6Z"/></svg>;}
function Packs({enabled,busy=false,bonusBps=0,onChoose}:{enabled:boolean;busy?:boolean;bonusBps?:number;onChoose:(code:string)=>void}){
 const [selected,setSelected]=useState("CNY50");
 // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role -- The specified radio cards implement roving focus and keyboard selection.
 return <div className="zs-packs" role="radiogroup" aria-label="选择充值档位">{packs.map((pack,index)=>{const active=selected===pack.code;return <article key={pack.code} role="radio" aria-checked={active} tabIndex={active?0:-1} className={`zs-pack${pack.yuan===50?" is-featured":""}${active?" is-selected":""}`} onClick={()=>setSelected(pack.code)} onKeyDown={event=>{
  if(event.target!==event.currentTarget)return;
  if(event.key==="Enter"||event.key===" "){event.preventDefault();setSelected(pack.code);}
  else if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();const next=(index+(event.key==="ArrowRight"?1:-1)+packs.length)%packs.length;setSelected(packs[next].code);(event.currentTarget.parentElement?.children[next] as HTMLElement|undefined)?.focus();}
 }}>
  {pack.yuan===50&&<span className="zs-pack-ribbon">推荐</span>}
  {active&&<span className="zs-pack-check" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></span>}
  <div className="zs-pack-top"><span>{pack.bonus?"积分包":"轻松开始"}</span>{pack.bonus>0&&<span className="zs-pack-bonus">赠送 {pack.bonus}%</span>}</div>
  <h3 className="zs-pack-price"><small>¥</small>{pack.yuan}</h3>
  <strong className="zs-pack-credits">{(pack.credits+Math.floor(pack.credits*bonusBps/10000)).toLocaleString()}<small> 积分</small></strong>
  <div className="zs-pack-detail">{pack.bonus>0?<><span><del>{(pack.yuan*100).toLocaleString()} 积分</del> → <b>{pack.credits.toLocaleString()} 积分</b></span><span>额外赠送 <em>{(pack.credits-pack.yuan*100).toLocaleString()}</em> 积分</span></>:<><b>1 元 = 100 积分</b><span>适合初次体验</span></>}</div>
  {bonusBps>0&&<p className="summary-note">含受邀专享 +{Math.floor(pack.credits*bonusBps/10000).toLocaleString()} 积分（套餐积分的 {bonusBps/100}%）</p>}
  <button type="button" className={`zs-pay-button${active?" is-primary":""}`} disabled={!enabled||busy} onClick={event=>{event.stopPropagation();setSelected(pack.code);onChoose(pack.code);}}>{enabled&&!busy&&<WechatIcon/>}{!enabled?"暂未开放":busy?"正在确认…":"微信支付"}</button>
 </article>;})}</div>;
}
export function RechargePanel(){
 const session=useSession();const [catalog,setCatalog]=useState({enabled:false,bonusBps:0,scope:""});
 const scope=session?.draftScope??"";
 useEffect(()=>{const abort=new AbortController();fetch("/api/recharge/catalog",{signal:abort.signal}).then(response=>{if(!response.ok)throw new Error("CATALOG_UNAVAILABLE");return response.json();}).then(data=>{if(!abort.signal.aborted)setCatalog({enabled:data.enabled===true,bonusBps:data.bonusBps===500?500:0,scope});}).catch(()=>{if(!abort.signal.aborted)setCatalog({enabled:false,bonusBps:0,scope});});return()=>abort.abort();},[scope]);
 const enabled=catalog.scope===scope&&catalog.enabled,bonusBps=catalog.scope===scope?catalog.bonusBps:0;
 return <>{session?.user.authenticated?<Checkout key={scope} scope={scope} enabled={enabled} bonusBps={bonusBps}/>:<Packs enabled={enabled} onChoose={()=>{requireClientAccess();}}/>}<p className="summary-note zs-pay-note">{enabled&&<WechatIcon/>}{enabled?"微信扫码支付。付款确认后积分到账，可在此查询同一订单。":"充值暂未开放，以上套餐仅供预览。"}</p></>;
}
function Checkout({scope,enabled,bonusBps}:{scope:string;enabled:boolean;bonusBps:number}){
 const [open,setOpen]=useState(false);
 const celebrated=useRef<string|undefined>(undefined);
 const dialog=useRef<HTMLDivElement>(null);
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
  if(!requireClientAccess()||!enabled||busy)return;setOpen(true);setBusy(true);setMessage("");
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
 const credited=order?.status==="CREDITED",creditedId=credited?order.id:undefined;
 useEffect(()=>{if(!creditedId||celebrated.current===creditedId)return;celebrated.current=creditedId;setOpen(true);const t=setTimeout(celebrate,120);return()=>clearTimeout(t);},[creditedId]);
 const visible=open&&Boolean(order||pending);
 useEffect(()=>{if(!visible)return;dialog.current?.focus({preventScroll:true});const close=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false);};document.addEventListener("keydown",close);return()=>document.removeEventListener("keydown",close);},[visible]);
 const waiting=order?.status==="PENDING"&&!order.reconciliation&&!expired;
 const remaining=Math.max(0,(order?.expiresAt??now)-now),duration=order?Math.round((order.expiresAt-order.createdAt)/60):0;
 const pendingPack=packs.find(pack=>pack.code===pending?.productCode);
 const warnings=<>{storageWarning&&<p className="summary-note zs-checkout-note" role="status">浏览器存储不可用，请保持本页并勿重复充值；恢复存储后可继续查询原订单。</p>}{message&&(!credited||message!=="支付已确认，积分已到账。")&&<p className="summary-note zs-checkout-note" role="status">{message}</p>}</>;
 const queryButton=<button type="button" className={credited?"zs-link-button":"secondary-button"} disabled={busy} onClick={()=>{if(order?.id)void query(order.id);else if(pending?.orderId)void query(pending.orderId);else if(pending)void checkout(pending.productCode);}}>查询同一订单</button>;
 return <><Packs enabled={enabled} busy={busy} bonusBps={bonusBps} onChoose={code=>void checkout(code)}/>
  {visible&&typeof document!=="undefined"&&createPortal(<div className="zs-modal" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setOpen(false);}}>
   <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="微信充值订单" className={`native-checkout zs-checkout${credited?" is-credited":""}${showCode?" has-code":""}`}>
    <button type="button" className="zs-modal-close" aria-label="关闭" onClick={()=>setOpen(false)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg></button>
    {credited?<div className="zs-success">
     <span className="native-success-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="m8 16 5 5 11-11" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg></span>
     <h3>支付成功，积分已到账</h3><p className="native-credit-total">+{(order.credits+(order.bonusCredits??0)).toLocaleString()}<small> 积分</small></p>
     <p className="native-order-status">{`实付 ¥${(order.amountFen/100).toFixed(2)} · 可继续你的空间创作`}</p>
     <div className="zs-success-receipt"><span>¥{order.amountFen/100} 积分包</span><span>{order.credits+(order.bonusCredits??0)>order.amountFen?<>含赠送 <b>{order.credits+(order.bonusCredits??0)-order.amountFen}</b> 积分</>:"1 元 = 100 积分"}</span></div>
     {warnings}<div className="native-checkout-actions zs-success-actions"><a className="primary-button" href="/studio">开始设计</a><a className="secondary-button" href="/profile">查看积分</a></div>{queryButton}
    </div>:<>
     <div className="zs-checkout-main">
      <div className="native-checkout-heading"><span className="zs-wxpay"><i><WechatIcon/></i>微信支付</span><span>造室 · 积分充值</span></div>
      <h3>{order?.reconciliation?"订单待核对":showCode?"微信扫码支付":"充值订单"}</h3>
      {order&&<div className="native-order-amount"><strong><small>¥</small>{(order.amountFen/100).toFixed(2)}</strong><span>到账 {(order.credits+(order.bonusCredits??0)).toLocaleString()} 积分</span></div>}
      {showCode&&<ol className="zs-checkout-steps"><li>打开微信，扫描二维码</li><li>确认支付后返回本页</li><li>点击「查询同一订单」确认积分到账</li></ol>}
      <p className="native-order-status">{order?.reconciliation?"支付需要进一步核对，暂未增加积分。请联系客服处理，勿重复付款。":order?.status==="CANCELED"?"原订单已确认关闭，可重新选择套餐。":order?.status==="EXPIRED"?"原订单已过期，微信确认未找到该订单，可重新选择套餐。":expired?"二维码已过期，订单状态仍需确认。":showCode?"打开微信扫一扫，扫描二维码完成付款。请勿重复付款。":"正在核对原订单，暂不显示支付二维码。"}</p>
      {warnings}<div className="native-checkout-actions">{queryButton}{order?.status==="PENDING"&&!order.reconciliation&&<button className="secondary-button" disabled={busy} onClick={()=>void closeOrder()}>取消订单 / 更换套餐</button>}{(order?.status==="CANCELED"||order?.status==="EXPIRED")&&!order.reconciliation&&<button className="secondary-button" disabled={busy} onClick={reset}>开始新的充值</button>}</div>
     </div>
     {showCode&&<div className="zs-checkout-qr"><div className="native-qr"><QRCodeSVG value={order!.codeUrl!} size={200} marginSize={2} fgColor="#000000" bgColor="#ffffff" title="使用微信扫描支付"/></div><p className="zs-scan"><WechatIcon/>请使用微信扫一扫</p><p className="zs-timer">二维码有效期 {duration} 分钟 · 剩余 {String(Math.floor(remaining/60)).padStart(2,"0")}:{String(remaining%60).padStart(2,"0")}</p></div>}
    </>}
   </div>
  </div>,document.body)}
  {!visible&&<>{(order||pending)&&!credited&&<div className="zs-resume" role="status"><span className="zs-resume-dot" aria-hidden="true"/><span>{waiting?`你有一笔 ¥${(order.amountFen/100).toFixed(0)} 订单待支付`:order?"你有一笔充值订单待确认":`你有一笔 ¥${pendingPack?.yuan??""} 充值订单待确认`}</span><button type="button" onClick={()=>setOpen(true)}>{waiting?"继续支付":"查看订单"}</button></div>}{warnings}</>}
 </>;
}
