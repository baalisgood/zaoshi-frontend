"use client";

export function AdminPagination({ pageNumber, count, hasNext, busy, previous, next }: { pageNumber: number; count: number; hasNext: boolean; busy: boolean; previous: () => void; next: () => void }) {
  return <nav className="admin-pagination" aria-label="数据分页"><span>第 {pageNumber} 页 · 本页 {count} 条 · 每页最多 25 条</span><div><button type="button" disabled={busy || pageNumber === 1} onClick={previous}>上一页</button><button type="button" disabled={busy || !hasNext} onClick={next}>下一页</button></div>{busy && <span role="status">正在读取…</span>}</nav>;
}
