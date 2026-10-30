
// Freeze these terms on order creation; later pricing changes never rewrite paid rewards.
export const REFERRAL_TERMS = { version: 'referral-v1-20261029', commissionBps: 800, bonusBps: 500 } as const;
export function invitationCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z0-9]{8}$/.test(value) ? value : null;
}
export function registrationReferral(d1: D1Database, userId: string, code: unknown, kind: 'email' | 'wechat', receipt: string, gate = '1=1', values: unknown[] = []): D1PreparedStatement {
  return d1.prepare(`INSERT INTO user_referrals(invitee_id,promoter_id)
    SELECT u.id,p.user_id FROM users u JOIN referral_promoters p ON p.user_id=? JOIN users promoter ON promoter.id=p.user_id
    WHERE u.id=? AND u.${kind}_registration_receipt=? AND u.status='ACTIVE' AND p.enabled=1 AND promoter.status='ACTIVE' AND u.id<>p.user_id AND (${gate})
    ON CONFLICT(invitee_id) DO NOTHING`).bind(invitationCode(code), userId, receipt, ...values);
}
export async function referralProfile(d1: D1Database, ownerId: string, after = '') {
  const promoter = await d1.prepare('SELECT enabled FROM referral_promoters WHERE user_id=?').bind(ownerId).first<{enabled:number}>();
  if (!promoter) return null;
  const [summary, page] = await Promise.all([
    d1.prepare(`SELECT (SELECT COUNT(*) FROM user_referrals WHERE promoter_id=?) AS invitedCount,
      COALESCE((SELECT SUM(t.commission_fen) FROM referral_order_terms t JOIN referral_rewards r ON r.order_id=t.order_id WHERE t.promoter_id=?),0) AS accruedFen`).bind(ownerId,ownerId).first<{invitedCount:number;accruedFen:number}>(),
    d1.prepare('SELECT invitee_id AS id,created_at AS registeredAt FROM user_referrals WHERE promoter_id=? AND invitee_id>? ORDER BY invitee_id LIMIT 26').bind(ownerId,after).all<{id:string;registeredAt:number}>(),
  ]);
  const rows=page.results??[];
  return { enabled: Boolean(promoter.enabled), invitationPath: `/login?invite=${encodeURIComponent(ownerId)}`, ...REFERRAL_TERMS, invitedCount:Number(summary?.invitedCount??0), accruedFen:Number(summary?.accruedFen??0), invitees:rows.slice(0,25), nextCursor:rows.length>25?rows[24].id:null };
}
