import { ApiError } from "./api";
export type BoundedResponseOptions = { maxBytes: number; tooLargeCode: string; invalidCode: string; label: string; timeoutMs?: number; signal?: AbortSignal };

export async function readBoundedResponseText(
  response: Response,
  options: BoundedResponseOptions,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > options.maxBytes) {
    throw new ApiError(502, options.tooLargeCode, `${options.label}返回内容过大。`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, options.invalidCode, `${options.label}没有返回有效内容。`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let stop: (reason: unknown) => void = () => undefined;
  const interrupted = new Promise<never>((_resolve,reject) => { stop=reject; });
  let interruption: ApiError | undefined;
  const cancel = () => { interruption=new ApiError(408,options.invalidCode,`${options.label}读取超时或连接中断。`); stop(interruption); void reader.cancel().catch(() => undefined); };
  const deadline = setTimeout(cancel,options.timeoutMs ?? 10000);
  options.signal?.addEventListener("abort",cancel,{once:true});
  try {
    if(options.signal?.aborted)cancel();
    while (true) {
      const part = await Promise.race([reader.read(),interrupted]);
      if (interruption) throw interruption;
      if (part.done) break;
      total += part.value.byteLength;
      if (total > options.maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ApiError(502, options.tooLargeCode, `${options.label}返回内容过大。`);
      }
      chunks.push(part.value);
    }
  } finally { clearTimeout(deadline); options.signal?.removeEventListener("abort",cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function readBoundedJsonResponse<T>(response: Response, options: BoundedResponseOptions): Promise<T> {
  const text = await readBoundedResponseText(response, options);
  try { return JSON.parse(text) as T; } catch { throw new ApiError(502, options.invalidCode, `${options.label}返回格式无效。`); }
}
