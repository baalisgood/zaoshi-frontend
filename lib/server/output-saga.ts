export type SagaAsset = { id: string; ownerId: string; status: string };
export type SagaRecoveryDecision = "attach" | "wait" | "cleanup" | "retry-tombstone";

export function resolveMemoryOrdinal<T extends SagaAsset>(
  rows: Array<{ assetId: string; ordinal: number }>,
  assets: Map<string, T>,
  ordinal: number,
  ownerId: string,
): T | null {
  const row = rows.find((candidate) => candidate.ordinal === ordinal);
  if (!row) return null;
  const asset = assets.get(row.assetId);
  if (!asset || asset.ownerId !== ownerId || asset.status !== "READY") return null;
  return asset;
}

export function decideRecovery(
  status: "PENDING" | "READY" | "DELETED",
  hasValidObject: boolean,
  ageMs: number,
  thresholdMs: number,
): SagaRecoveryDecision {
  if (status === "DELETED") return "retry-tombstone";
  if (hasValidObject) return "attach";
  if (status === "READY") return "cleanup";
  return ageMs > thresholdMs ? "cleanup" : "wait";
}
