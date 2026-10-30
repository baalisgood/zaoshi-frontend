// Display-only labels for backend codes. Unknown codes fall back to the raw value so nothing is hidden.
type Tone = "neutral" | "info" | "success" | "warning" | "danger";
type Entry = readonly [label: string, tone: Tone];

const taskStatus: Record<string, Entry> = {
  QUEUED: ["排队中", "info"], LEASED: ["已领取", "info"], PREPROCESSING: ["预处理", "info"], SUBMITTING: ["提交中", "info"], PERSISTING: ["保存结果", "info"],
  RETRY_WAIT: ["等待重试", "warning"], SUCCEEDED: ["成功", "success"], FAILED: ["失败", "danger"], RECONCILIATION_REQUIRED: ["待对账", "warning"], CANCELED: ["已取消", "neutral"],
};
const billingState: Record<string, Entry> = { UNBILLED: ["未计费", "neutral"], RESERVED: ["已冻结", "warning"], SETTLED: ["已结算", "success"], RELEASED: ["已释放", "info"] };
const ledgerEntry: Record<string, Entry> = { CREDIT: ["入账", "success"], RESERVE: ["冻结", "warning"], SETTLE: ["结算扣除", "info"], RELEASE: ["释放", "neutral"] };
const orderStatus: Record<string, Entry> = { PENDING: ["待支付", "info"], PAID: ["已支付", "info"], CREDITED: ["已到账", "success"], CANCELED: ["已取消", "neutral"], EXPIRED: ["已过期", "neutral"] };
const auditSource: Record<string, Entry> = {
  ADMIN: ["管理员", "info"], QUEUE: ["任务重排", "warning"], RECONCILIATION: ["任务对账", "warning"], ASSET_MAINTENANCE: ["文件维护", "neutral"],
  ASSET_MODERATION: ["图片审核", "neutral"], ASSET_DELETION: ["图片删除", "danger"], GALLERY: ["灵感库", "success"],
};
const reasonCode: Record<string, string> = {
  PROMPT_OPTIMIZATION: "AI 提示词优化", RECHARGE_PAID: "充值到账", ADMIN_GRANT: "运营赠送", ADMIN_COMPENSATION: "故障补偿",
  OUTPUT_MODERATION_REJECTED: "结果审核未通过", SAFE_BEFORE_PROVIDER: "调用前失败（安全退回）",
};

export const taskStatusValues = Object.keys(taskStatus);
export const taskStatusLabel = (value: string) => taskStatus[value]?.[0] ?? value;
export const reasonLabel = (value: string) => reasonCode[value] ?? value;
export const roleLabel = (value: string) => ({ ADMIN: "管理员", USER: "用户" } as Record<string, string>)[value] ?? value;

function Chip({ entry, code }: { entry?: Entry; code: string }) {
  return <span className={`zs-chip is-${entry?.[1] ?? "neutral"}`} title={code}>{entry?.[0] ?? code}</span>;
}
export const TaskStatusChip = ({ value }: { value: string }) => <Chip entry={taskStatus[value]} code={value} />;
export const BillingChip = ({ value }: { value: string }) => <Chip entry={billingState[value]} code={value} />;
export const LedgerChip = ({ value }: { value: string }) => <Chip entry={ledgerEntry[value]} code={value} />;
export const OrderStatusChip = ({ value }: { value: string }) => <Chip entry={orderStatus[value]} code={value} />;
export const AuditSourceChip = ({ value }: { value: string }) => <Chip entry={auditSource[value]} code={value} />;
export const ToneChip = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => <span className={`zs-chip is-${tone}`}>{children}</span>;

export function formatNumber(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN") : String(value ?? 0);
}
