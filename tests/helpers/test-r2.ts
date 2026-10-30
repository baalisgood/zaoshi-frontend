type StoredObject = {
  bytes: Uint8Array;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
  etag: string;
};

export class TestR2Bucket implements R2Bucket {
  readonly objects = new Map<string, StoredObject>();

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string | string[] };
    },
  ): Promise<unknown | null> {
    if (
      options?.onlyIf?.etagDoesNotMatch === "*" &&
      this.objects.has(key)
    ) {
      return null;
    }
    const bytes = await toBytes(value);
    const object = {
      bytes,
      customMetadata: options?.customMetadata,
      httpMetadata: options?.httpMetadata,
      etag: `etag-${bytes.byteLength}-${this.objects.size + 1}`,
    };
    this.objects.set(key, object);
    return object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const bytes = object.bytes.slice();
    return {
      customMetadata: object.customMetadata,
      httpMetadata: object.httpMetadata,
      etag: object.etag,
      async arrayBuffer() {
        const stable = new Uint8Array(bytes.byteLength);
        stable.set(bytes);
        return stable.buffer;
      },
    };
  }

  async delete(key: string | string[]): Promise<void> {
    for (const item of Array.isArray(key) ? key : [key]) {
      this.objects.delete(item);
    }
  }
}

async function toBytes(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  }
  return new Uint8Array(value.slice(0));
}
