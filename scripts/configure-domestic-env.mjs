import { randomUUID } from "node:crypto";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const target = resolve(".env.local");
const allowed = [
  "BACKEND_PROFILE",
  "ARK_API_KEY",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_WORKSPACE_ID",
];

const stat = await lstat(target);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error(".env.local must be a regular file and not a symbolic link");
}
if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
  throw new Error(".env.local must be owned by the current user");
}

const sourceHandle = await open(target, "r");
let source;
try {
  source = await sourceHandle.readFile("utf8");
} finally {
  await sourceHandle.close();
}

const values = new Map();
for (const rawLine of source.split(/\r?\n/u)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(rawLine);
  if (!match) throw new Error(".env.local contains an unsupported line");
  values.set(match[1], match[2]);
}

values.set("BACKEND_PROFILE", "cn-production");
const content = [
  "# Local domestic-provider smoke tests only. Never commit this file.",
  ...allowed.map((key) => `${key}=${values.get(key) ?? ""}`),
  "",
].join("\n");

const temporary = join(dirname(target), `.env.local.${randomUUID()}.tmp`);
const output = await open(temporary, "wx", 0o600);
try {
  await output.writeFile(content, "utf8");
  await output.sync();
} catch (error) {
  await output.close().catch(() => undefined);
  await unlink(temporary).catch(() => undefined);
  throw error;
}
await output.close();
await chmod(temporary, 0o600);
await rename(temporary, target);

const missing = allowed.filter(
  (key) => key !== "BACKEND_PROFILE" && !(values.get(key) ?? "").trim(),
);
console.log(".env.local 已整理为豆包 Seedream 与阿里千问两类供应商配置。");
if (missing.length > 0) console.log(`待填写变量：${missing.join(", ")}`);
