import { referralProfile } from "@/lib/server/referrals";
import { getD1Binding } from "@/db";
import { recoverOptimizations } from "@/lib/server/prompt-optimization";
import { getCreditSnapshot } from "@/lib/server/credit-ledger";
import { readLegalConsent } from "@/lib/server/legal-consent";
import { LEGAL_VERSION } from "@/lib/domain/legal";
import { attachActorCookie } from "@/lib/server/actor";
import { hashIdentifier } from "@/lib/server/actor";
import { getRuntimeRequestActor as getRequestActor } from "@/lib/server/runtime-actor";
import { errorResponse, jsonResponse } from "@/lib/server/api";
import { isGalleryAdmin } from "@/lib/server/gallery";
import { readWechatAuthConfig, validateWechatAuthConfig } from "@/lib/server/wechat-auth-config";
import { getGenerationQuotaSnapshot } from "@/lib/server/generation-quota";
import { isSiteAdmin } from "@/lib/server/admin";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { PRIVATE_TEST_OWNER, resolvePrivateTestConfig } from "@/lib/server/private-test";
import {
  getAssetStats,
  getStorageMode,
  storageHeaders,
} from "@/lib/server/persistence";

export async function GET(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const actor = await getRequestActor(request);
  const bindings = readRuntimeBindings();
  const privateTest = actor.trusted === true && actor.user.authenticated && Boolean(resolvePrivateTestConfig(bindings)) && actor.ownerId === PRIVATE_TEST_OWNER;

  try {
    const d1 = getD1Binding();
    if (d1 && actor.trusted && actor.user.authenticated) await recoverOptimizations(d1, actor.ownerId);
    const [stats, generationQuota, credits, accepted] = await Promise.all([
      getAssetStats(actor.ownerId),
      getGenerationQuotaSnapshot(actor.ownerId, privateTest),
      d1 && actor.trusted === true && actor.user.authenticated ? getCreditSnapshot(d1, actor.ownerId) : null,
      privateTest ? true : d1 && actor.trusted === true && actor.user.authenticated ? readLegalConsent(d1, actor.ownerId) : false,
    ]);
    const wechatConfig = readWechatAuthConfig();
    const wechatReady = validateWechatAuthConfig(wechatConfig);
    const wechatBound = Boolean(wechatReady && d1 && actor.trusted && actor.user.authenticated && await d1.prepare("SELECT 1 FROM auth_identities WHERE user_id=? AND provider='wechat' AND provider_app_id=?").bind(actor.ownerId,wechatConfig.appId).first());
    return attachActorCookie(
      jsonResponse(
        {
          user: actor.user,
          referral: d1 && actor.trusted && actor.user.authenticated ? await referralProfile(d1, actor.ownerId) : null,
          credits,
          legal: { version: LEGAL_VERSION, accepted },
          draftScope: hashIdentifier(`draft:${actor.identityNamespace ?? actor.ownerId}`),
          authMode: wechatConfig.mode,
          wechat: { enabled: wechatReady, bound: wechatBound },
          privateTest,
          isGalleryAdmin: isGalleryAdmin(actor),
          isSiteAdmin: isSiteAdmin(actor, bindings),
          generationQuota,
          stats,
          persistence: getStorageMode(),
        },
        { headers: storageHeaders() },
      ),
      actor,
    );
  } catch (error) {
    return attachActorCookie(errorResponse(error, requestId), actor);
  }
}
