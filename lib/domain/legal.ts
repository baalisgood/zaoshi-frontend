export const LEGAL_VERSION = "20261005-v1";
export function safeReturnPath(value: string | null, fallback = "/profile"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.startsWith("/api/") || value.length > 512 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fallback;
  return value;
}
export const legalDocuments = ["terms", "privacy"] as const;
export function hasCurrentLegalConsent(input: unknown): boolean {
  return Boolean(input && typeof input === "object" && (input as Record<string, unknown>).accepted === true && (input as Record<string, unknown>).version === LEGAL_VERSION);
}
