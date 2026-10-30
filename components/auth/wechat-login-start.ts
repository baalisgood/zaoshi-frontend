import { responseMessage } from "@/components/site/api";

type WechatStart = { appid: string; scope: string; redirect_uri: string; state: string; expiresAt: number };
let pending: { returnTo: string; promise: Promise<WechatStart> } | undefined;

export function startEmbeddedWechatLogin(returnTo: string, inviteCode = ""): Promise<WechatStart> {
  const key = `${returnTo}|${inviteCode}`;
  if (pending?.returnTo === key) return pending.promise;
  const previous = pending?.promise;
  const promise = (async () => {
    await previous?.catch(() => undefined);
    // Do not abort on component exit: the server may still be issuing this browser's single state.
    const response = await fetch(`/api/auth/wechat/start?returnTo=${encodeURIComponent(returnTo)}&invite=${encodeURIComponent(inviteCode)}`, { method: "POST", credentials: "same-origin" });
    if (!response.ok) throw new Error(await responseMessage(response, "二维码加载失败，请重试。"));
    return await response.json() as WechatStart;
  })();
  pending = { returnTo: key, promise };
  const clear = () => { if (pending?.promise === promise) pending = undefined; };
  void promise.then(clear, clear);
  return promise;
}
