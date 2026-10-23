"use client";

import { useState } from "react";

export function userIdentifierLabel(id: string): string {
  return /^user_[a-f0-9]{64}$/u.test(id) ? `${id.slice(5, 17)}…` : id;
}

export function UserIdentifier({ id }: { id: string }) {
  const [message, setMessage] = useState("");
  const label = userIdentifierLabel(id);
  const copy = async () => {
    try { await navigator.clipboard.writeText(id); setMessage("已复制完整 ID"); }
    catch { setMessage("复制失败，请选择完整 ID 后手动复制。"); }
  };
  return <div className="admin-identifier">{label === id ? <span className="admin-identifier-value">{id}</span> : <details><summary>{label}<span>简写</span></summary><span className="admin-identifier-full">{id}</span></details>}<button type="button" onClick={() => void copy()} aria-label={`复制完整用户 ID ${id}`}>复制</button>{message && <span className="admin-identifier-message" role="status">{message}</span>}</div>;
}
