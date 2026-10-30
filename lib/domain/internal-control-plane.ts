export type InternalControlPlaneTransport = "https" | "private-docker";

const PRIVATE_DOCKER_ORIGIN = "http://zaoshi-web:3000";

export function resolveInternalControlPlaneTransport(
  value: unknown,
): InternalControlPlaneTransport {
  if (value === undefined || value === null || value === "" || value === "https") {
    return "https";
  }
  if (value === "private-docker") return value;
  throw new Error("INVALID_CONTROL_PLANE_TRANSPORT");
}

export function normalizeInternalControlPlaneBaseUrl(
  value: string | undefined,
  transport: InternalControlPlaneTransport,
): string {
  if (!value) throw new Error("CONTROL_PLANE_URL_REQUIRED");
  const parsed = new URL(value);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error("INVALID_CONTROL_PLANE_URL");
  }
  if (transport === "private-docker") {
    if (parsed.origin !== PRIVATE_DOCKER_ORIGIN) {
      throw new Error("INVALID_CONTROL_PLANE_URL");
    }
  } else if (
    parsed.protocol !== "https:" ||
    (parsed.port && parsed.port !== "443")
  ) {
    throw new Error("INVALID_CONTROL_PLANE_URL");
  }
  return parsed.toString();
}

export function isAllowedInternalControlPlaneRequest(
  url: URL,
  transport: InternalControlPlaneTransport,
): boolean {
  if (url.username || url.password || url.search || url.hash) return false;
  if (transport === "private-docker") {
    return url.origin === PRIVATE_DOCKER_ORIGIN;
  }
  return url.protocol === "https:" && (!url.port || url.port === "443");
}
