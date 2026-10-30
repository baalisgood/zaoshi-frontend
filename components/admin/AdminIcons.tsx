// Small stroke icons used only by the admin console.
const paths = {
  overview: "M4 13h6V4H4zm10 7h6v-9h-6zM4 20h6v-4H4zm10-11h6V4h-6z",
  users: "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.6a3 3 0 0 1 0 5.8",
  credits: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v8m-3-5.5h4.5a1.75 1.75 0 0 1 0 3.5H10",
  recharge: "M3 7h18v12H3zM3 11h18M7 15h4",
  tasks: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  providers: "M4 7l8-4 8 4-8 4zm0 5 8 4 8-4M4 17l8 4 8-4",
  analytics: "M4 20V10m6 10V4m6 16v-7m4 7H3",
  audit: "M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6zm-3 9 2 2 4-4",
  content: "M4 5h16v14H4zm0 10 4-4 4 4 3-3 5 5M15 9h.01",
  gallery: "M3 5h8v8H3zm10 0h8v5h-8zM3 15h8v4H3zm10-3h8v7h-8z",
  reconciliation: "M7 7h10l-3-3m3 13H7l3 3M17 7v4M7 17v-4",
  deadLetters: "M12 9v4m0 4h.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  back: "M15 18l-6-6 6-6",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 8v5m0 3.5h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  arrow: "M7 17 17 7M9 7h8v8",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4.2-4.2",
} as const;

export type AdminIconName = keyof typeof paths;

export function AdminIcon({ name, size = 18 }: { name: AdminIconName; size?: number }) {
  return <svg className="zs-admin-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
