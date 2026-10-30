import { jsonResponse } from "@/lib/server/api";

function disabled() { return jsonResponse({ error: { code: "GALLERY_DEVELOPER_CURATED", message: "灵感库不使用人工投稿审核。" } }, { status: 404 }); }
export function GET() { return disabled(); }
export function PATCH() { return disabled(); }
