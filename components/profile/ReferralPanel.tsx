"use client";
import { useState, useSyncExternalStore } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { referralProfile } from '@/lib/server/referrals';
export type ReferralSummary = NonNullable<Awaited<ReturnType<typeof referralProfile>>>;
const subscribe = () => () => {};
const getOrigin = () => window.location.origin;
export function ReferralPanel({ summary }: { summary: ReferralSummary }) {
 const [message,setMessage]=useState('');
 const origin=useSyncExternalStore(subscribe,getOrigin,()=> '');
 const link=origin?new URL(summary.invitationPath,origin).href:'';
 return <section className="profile-card referral-panel"><header><div><h2>我的推广</h2><p>受邀用户每次充值额外获赠 5% 积分，你获得实付金额 8% 的返现。</p></div><span className="status-pill">{summary.enabled?'推广中':'停止新增邀请'}</span></header>
  <div className="referral-summary"><div><span>累计应计返现</span><strong>¥{(summary.accruedFen/100).toFixed(2)}</strong><small>待人工核对结算，尚未转账</small></div><div><span>已邀请用户</span><strong>{summary.invitedCount.toLocaleString()}<small> 人</small></strong></div></div>
  {summary.enabled && <div className="referral-share"><div className="referral-qr">{link&&<QRCodeSVG value={link} size={144} marginSize={2} title="推广邀请二维码"/>}</div><div><label htmlFor="referral-link">专属邀请链接</label><input id="referral-link" readOnly value={link}/><button type="button" className="secondary-button" onClick={()=>void navigator.clipboard.writeText(link).then(()=>setMessage('邀请链接已复制')).catch(()=>setMessage('复制失败，请选中链接手动复制'))}>复制邀请链接</button><p>分享链接或二维码，新用户注册时自动关联。已注册账户不参与邀请绑定。</p></div></div>}
  {message&&<p role="status">{message}</p>}
 </section>;
}
