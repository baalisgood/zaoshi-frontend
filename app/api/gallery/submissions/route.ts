import { jsonResponse } from "@/lib/server/api";

function disabled() { return jsonResponse({ error: { code: "GALLERY_DEVELOPER_CURATED", message: "灵感库由开发者维护，不接受用户投稿。" } }, { status: 404 }); }
export function GET() { return disabled(); }
export function POST() { return disabled(); }
