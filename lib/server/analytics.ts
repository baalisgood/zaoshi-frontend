import { rechargeSummary } from "./recharge-native-orders";
import { createHash } from "node:crypto";
import { ApiError, readJsonBody, requireJsonObject } from "./api";
import { randomToken, readCookie } from "./actor";

const ANALYTICS_COOKIE = "zaoshi_analytics";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const VIEW_ID_PATTERN = /^view_[0-9a-f-]{36}$/u;
const MAX_DAILY_VIEWS_PER_VISITOR = 500;
const MAX_SITE_DAILY_VIEWS = 10_000;
const RETENTION_DAYS = 90;
const trackedPaths = new Set(["/", "/studio", "/pro", "/floorplan", "/self-service", "/library", "/profile"]);

export type AnalyticsPeriod = "day" | "week" | "month";

export async function recordAnalyticsEvent(request: Request, d1: D1Database): Promise<{ accepted: boolean; setCookie: string | null }> {
  const body = requireJsonObject(await readJsonBody(request, 2 * 1024));
  const action = body.action;
  const viewId = typeof body.viewId === "string" ? body.viewId : "";
  if (!VIEW_ID_PATTERN.test(viewId)) throw new ApiError(400, "INVALID_ANALYTICS_EVENT", "访问统计事件无效。");

  const existing = readCookie(request.headers.get("cookie"), ANALYTICS_COOKIE);
  const validExisting = Boolean(existing && TOKEN_PATTERN.test(existing));
  const token = validExisting ? existing! : randomToken();
  const visitorHash = createHash("sha256").update(token).digest("hex");
  const setCookie = validExisting ? null : analyticsCookie(request, token);

  if (action === "start") {
    const path = typeof body.path === "string" ? body.path : "";
    if (!trackedPaths.has(path)) throw new ApiError(400, "INVALID_ANALYTICS_PATH", "访问页面不在统计范围内。");
    const result = await d1.prepare(
      `INSERT INTO site_page_views (id, visitor_hash, path)
       SELECT ?, ?, ?
       WHERE (SELECT COUNT(*) FROM site_page_views
              WHERE started_at >= unixepoch('now','+8 hours','start of day','-8 hours')) < ?
         AND (SELECT COUNT(*) FROM site_page_views
              WHERE visitor_hash = ? AND started_at >= unixepoch('now','+8 hours','start of day','-8 hours')) < ?
       ON CONFLICT(id) DO NOTHING`,
    ).bind(viewId, visitorHash, path, MAX_SITE_DAILY_VIEWS, visitorHash, MAX_DAILY_VIEWS_PER_VISITOR).run();
    return { accepted: (result.meta?.changes ?? 0) === 1, setCookie };
  }

  if (action === "end") {
    if (!Number.isFinite(body.durationSeconds)) throw new ApiError(400, "INVALID_ANALYTICS_EVENT", "停留时间无效。");
    const duration = Math.max(0, Math.min(1800, Math.round(Number(body.durationSeconds))));
    const result = await d1.prepare(
      `UPDATE site_page_views
       SET duration_seconds = ?, ended_at = MAX(started_at, unixepoch())
       WHERE id = ? AND visitor_hash = ? AND ended_at IS NULL`,
    ).bind(duration, viewId, visitorHash).run();
    return { accepted: (result.meta?.changes ?? 0) === 1, setCookie };
  }

  throw new ApiError(400, "INVALID_ANALYTICS_EVENT", "访问统计动作无效。");
}

export async function purgeExpiredAnalytics(d1: D1Database, now = Math.floor(Date.now() / 1000)) {
  return d1.prepare("DELETE FROM site_page_views WHERE started_at < ?").bind(now - RETENTION_DAYS * 24 * 60 * 60).run();
}

export async function getAnalyticsSummary(d1: D1Database, period: AnalyticsPeriod, now = Math.floor(Date.now() / 1000)) {
  const start = periodStart(period, now);
  const [totals, series] = await Promise.all([
    d1.prepare(
      `SELECT COUNT(*) AS pv,
              COUNT(DISTINCT visitor_hash) AS uv,
              COALESCE(SUM(duration_seconds), 0) AS total_dwell,
              COUNT(duration_seconds) AS dwell_samples,
              COALESCE(AVG(duration_seconds), 0) AS average_dwell
       FROM site_page_views WHERE started_at >= ? AND started_at <= ?`,
    ).bind(start, now).first<{ pv: number; uv: number; total_dwell: number; dwell_samples: number; average_dwell: number }>(),
    d1.prepare(
      `SELECT strftime('%Y-%m-%d', started_at, 'unixepoch', '+8 hours') AS day,
              COUNT(*) AS pv, COUNT(DISTINCT visitor_hash) AS uv,
              COALESCE(AVG(duration_seconds), 0) AS average_dwell
       FROM site_page_views WHERE started_at >= ? AND started_at <= ?
       GROUP BY day ORDER BY day ASC`,
    ).bind(start, now).all<{ day: string; pv: number; uv: number; average_dwell: number }>(),
  ]);
  return {
    period,
    start,
    end: now,
    pv: Number(totals?.pv ?? 0),
    uv: Number(totals?.uv ?? 0),
    totalDwellSeconds: Number(totals?.total_dwell ?? 0),
    dwellSamples: Number(totals?.dwell_samples ?? 0),
    averageDwellSeconds: Math.round(Number(totals?.average_dwell ?? 0)),
    series: (series.results ?? []).map((row) => ({
      day: row.day,
      pv: Number(row.pv),
      uv: Number(row.uv),
      averageDwellSeconds: Math.round(Number(row.average_dwell)),
    })),
    recharge: await rechargeSummary(d1,start,now),
  };
}

export function parseAnalyticsPeriod(value: string | null): AnalyticsPeriod {
  if (!value || value === "day") return "day";
  if (value === "week" || value === "month") return value;
  throw new ApiError(400, "INVALID_FIELD", "period 只支持 day、week 或 month。");
}

function periodStart(period: AnalyticsPeriod, now: number): number {
  const china = new Date((now + 8 * 60 * 60) * 1000);
  const year = china.getUTCFullYear();
  const month = china.getUTCMonth();
  const day = china.getUTCDate();
  let utc = Date.UTC(year, month, day) / 1000 - 8 * 60 * 60;
  if (period === "week") utc -= ((china.getUTCDay() + 6) % 7) * 24 * 60 * 60;
  if (period === "month") utc = Date.UTC(year, month, 1) / 1000 - 8 * 60 * 60;
  return utc;
}

function analyticsCookie(request: Request, token: string): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${ANALYTICS_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`;
}
