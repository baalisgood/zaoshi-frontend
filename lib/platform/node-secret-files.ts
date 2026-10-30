import { createPrivateKey, createPublicKey } from "node:crypto";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SECRET_ROOT = "/run/secrets";
const MAX_SECRET_BYTES = 16 * 1024;

const SECRET_BINDINGS = [
  ["TENCENT_MODERATION_SECRET_ID_FILE", "TENCENT_MODERATION_SECRET_ID"],
  ["TENCENT_MODERATION_SECRET_KEY_FILE", "TENCENT_MODERATION_SECRET_KEY"],
  ["WECHAT_PAY_PRIVATE_KEY_FILE", "WECHAT_PAY_PRIVATE_KEY"],
  ["WECHAT_PAY_API_V3_KEY_FILE", "WECHAT_PAY_API_V3_KEY"],
  ["WECHAT_PAY_PUBLIC_KEY_FILE", "WECHAT_PAY_PUBLIC_KEY"],
  ["WECHAT_PAY_PREVIOUS_PUBLIC_KEY_FILE", "WECHAT_PAY_PREVIOUS_PUBLIC_KEY"],
  ["SMTP_AUTH_CODE_FILE", "SMTP_AUTH_CODE"],
  ["ARK_API_KEY_FILE", "ARK_API_KEY"],
  ["DASHSCOPE_API_KEY_FILE", "DASHSCOPE_API_KEY"],
  ["GENERATION_INTERNAL_CURRENT_SECRET_FILE", "GENERATION_INTERNAL_CURRENT_SECRET"],
  ["GENERATION_INTERNAL_PREVIOUS_SECRET_FILE", "GENERATION_INTERNAL_PREVIOUS_SECRET"],
  ["GENERATION_INTERNAL_TICKET_SECRET_FILE", "GENERATION_INTERNAL_TICKET_SECRET"],
  ["WECHAT_OPEN_SECRET_FILE", "WECHAT_OPEN_SECRET"],
  ["SESSION_SECRET_FILE", "SESSION_SECRET"],
  ["AUTH_IDENTITY_PEPPER_FILE", "AUTH_IDENTITY_PEPPER"],
] as const;

export function readNodeSecretBindings(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: {
    secretRoot?: string;
    effectiveUid?: number;
    lstat?: typeof lstatSync;
    readFile?: typeof readFileSync;
  } = {},
): Record<string, string> {
  const internalEnabled = environment.GENERATION_INTERNAL_API_ENABLED === "1";
  const wechatEnabled = environment.AUTH_MODE === "wechat" || (environment.AUTH_MODE === "email" && environment.WECHAT_LOGIN_ENABLED === "1");
  const emailEnabled = environment.AUTH_MODE === "email";
  const providerEnabled = environment.PUBLIC_IMAGE_GENERATION_ENABLED === "1" && environment.BACKEND_PROFILE === "cn-production" && emailEnabled;
  const privateTestEnabled = environment.AUTH_MODE === "private-test";
  const moderationEnabled = environment.TENCENT_MODERATION_ENABLED === "1";
  const paymentEnabled = environment.WECHAT_PAY_ENABLED === "1";
  if (!internalEnabled && !wechatEnabled && !emailEnabled && !privateTestEnabled && !moderationEnabled && !paymentEnabled) return {};
  if (environment.WECHAT_OPEN_APP_SECRET || environment.WECHAT_OPEN_APP_SECRET_FILE) throw new Error("WECHAT_OPEN_SECRET_CANONICAL_FILE_REQUIRED");
  const localRoot = environment.NODE_LOCAL_SECRET_ROOT?.trim();
  if (localRoot && (environment.BACKEND_PROFILE !== "sites-demo" || environment.AUTH_MODE !== "email" || environment.PUBLIC_IMAGE_GENERATION_ENABLED !== "0" || environment.GENERATION_INTERNAL_API_ENABLED !== "0" || environment.TENCENT_MODERATION_ENABLED !== "0" || environment.WECHAT_PAY_ENABLED !== "0" || environment.WECHAT_LOGIN_ENABLED === "1" || environment.SMTP_AUTH_CODE_FILE || environment.SMTP_AUTH_CODE)) {
    throw new Error("NODE_LOCAL_SECRET_ROOT_ISOLATION_REQUIRED");
  }
  const secretRoot = resolve(dependencies.secretRoot ?? localRoot ?? SECRET_ROOT);
  const io = {
    lstat: dependencies.lstat ?? lstatSync,
    readFile: dependencies.readFile ?? readFileSync,
  };
  const effectiveUid = dependencies.effectiveUid ?? process.geteuid?.();
  const rootStat = safeLstat(secretRoot, "NODE_SECRET_ROOT", io.lstat);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o022) !== 0
  ) {
    throw new Error("NODE_SECRET_ROOT_UNSAFE");
  }

  const bindings: Record<string, string> = {};
  for (const [fileName, bindingName] of SECRET_BINDINGS) {
    const providerSecret = bindingName === "ARK_API_KEY" || bindingName === "DASHSCOPE_API_KEY";
    if (providerSecret && !providerEnabled) continue;
    const moderationSecret = bindingName.startsWith("TENCENT_MODERATION_");
    const paymentSecret = bindingName.startsWith("WECHAT_PAY_");
    if ((moderationSecret && !moderationEnabled) || (paymentSecret && !paymentEnabled)) continue;
    const required = moderationSecret && moderationEnabled || paymentSecret && paymentEnabled && bindingName !== "WECHAT_PAY_PREVIOUS_PUBLIC_KEY" || providerSecret && providerEnabled || (internalEnabled
      ? ["GENERATION_INTERNAL_CURRENT_SECRET", "GENERATION_INTERNAL_TICKET_SECRET"].includes(bindingName)
      : false);
    const authRequired = (wechatEnabled
      ? ["WECHAT_OPEN_SECRET", "SESSION_SECRET", "AUTH_IDENTITY_PEPPER"].includes(bindingName)
      : emailEnabled && ["SESSION_SECRET", "AUTH_IDENTITY_PEPPER"].includes(bindingName));
    if (!required && !authRequired && !environment[fileName] && !environment[bindingName]) continue;
    const filePath = environment[fileName]?.trim();
    const directValue = environment[bindingName]?.trim();
    if (directValue) {
      throw new Error(
        filePath ? `${bindingName}_AMBIGUOUS` : `${bindingName}_MUST_USE_FILE`,
      );
    }
    if (!filePath && (required || authRequired)) {
      throw new Error(`${bindingName}_FILE_REQUIRED`);
    }
    if (!filePath) continue;
    bindings[bindingName] = readSecret(
      filePath,
      bindingName,
      secretRoot,
      effectiveUid,
      io,
    );
  }
  return bindings;
}

function readSecret(
  inputPath: string,
  name: string,
  secretRoot: string,
  effectiveUid: number | undefined,
  io: { lstat: typeof lstatSync; readFile: typeof readFileSync },
): string {
  if (!isAbsolute(inputPath) || !Number.isSafeInteger(effectiveUid)) {
    throw new Error(`${name}_FILE_UNSAFE`);
  }
  const path = resolve(inputPath);
  const nested = relative(secretRoot, path);
  if (!nested || nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
    throw new Error(`${name}_FILE_OUTSIDE_SECRET_ROOT`);
  }
  const parts = nested.split(sep);
  let current = secretRoot;
  let finalStat: Stats | null = null;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = safeLstat(current, `${name}_FILE`, io.lstat);
    if (stat.isSymbolicLink()) throw new Error(`${name}_FILE_UNSAFE`);
    if (index < parts.length - 1) {
      if (!stat.isDirectory() || (stat.mode & 0o022) !== 0) {
        throw new Error(`${name}_FILE_UNSAFE`);
      }
    } else {
      finalStat = stat;
    }
  }
  if (
    !finalStat?.isFile() ||
    finalStat.size > MAX_SECRET_BYTES ||
    ![0o400, 0o600].includes(finalStat.mode & 0o777) ||
    finalStat.uid !== effectiveUid
  ) {
    throw new Error(`${name}_FILE_UNSAFE`);
  }
  const secret = String(io.readFile(path, "utf8")).trim();
  if (["WECHAT_PAY_PRIVATE_KEY", "WECHAT_PAY_PUBLIC_KEY", "WECHAT_PAY_PREVIOUS_PUBLIC_KEY"].includes(name)) {
    try {
      if (secret.includes("\0") || secret.length > MAX_SECRET_BYTES) throw new Error();
      const key = name === "WECHAT_PAY_PRIVATE_KEY" ? createPrivateKey(secret) : createPublicKey(secret);
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
      return secret;
    } catch { throw new Error(`${name}_INVALID`); }
  }
  if (secret.length < (name === "SMTP_AUTH_CODE" ? 16 : name === "ARK_API_KEY" || name === "DASHSCOPE_API_KEY" ? 8 : 32) || secret.length > MAX_SECRET_BYTES || /[\r\n\0]/u.test(secret)) {
    throw new Error(`${name}_INVALID`);
  }
  return secret;
}

function safeLstat(
  path: string,
  name: string,
  lstat: typeof lstatSync,
): Stats {
  try {
    return lstat(path) as Stats;
  } catch {
    throw new Error(`${name}_UNAVAILABLE`);
  }
}
