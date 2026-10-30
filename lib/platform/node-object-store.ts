import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  constants,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

type ObjectMetadata = {
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
  etag: string;
};

export class NodeObjectBucket implements R2Bucket {
  private readonly root: string;
  private readonly dataRoot: string;
  private readonly metadataRoot: string;
  private readonly ready: Promise<void>;
  private readonly pendingWrites = new Map<string, Promise<unknown>>();

  constructor(root: string) {
    this.root = resolve(root);
    if (!isAbsolute(root) || this.root === "/") {
      throw new Error("ZAOSHI_OBJECT_ROOT must be an absolute directory");
    }
    this.dataRoot = join(this.root, "data");
    this.metadataRoot = join(this.root, "metadata");
    this.ready = this.initialize();
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagDoesNotMatch?: string | string[] };
    },
  ): Promise<unknown | null> {
    await this.ready;
    return this.serializeWrite(key, async () => {
      const paths = await this.pathsFor(key, true);
      const conditional = options?.onlyIf?.etagDoesNotMatch === "*";
      if (conditional) {
        try {
          await lstat(paths.data);
          return null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const bytes = await toBytes(value);
      const etag = createHash("sha256").update(bytes).digest("hex");
      const metadata: ObjectMetadata = {
        etag,
        ...(options?.customMetadata
          ? { customMetadata: options.customMetadata }
          : {}),
        ...(options?.httpMetadata ? { httpMetadata: options.httpMetadata } : {}),
      };
      await atomicWrite(
        paths.metadata,
        new TextEncoder().encode(JSON.stringify(metadata)),
      );
      await atomicWrite(paths.data, bytes);
      return metadata;
    });
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    await this.ready;
    const paths = await this.pathsFor(key, false);
    try {
      const [dataStat, metadataStat] = await Promise.all([
        lstat(paths.data),
        lstat(paths.metadata),
      ]);
      if (
        !dataStat.isFile() ||
        dataStat.isSymbolicLink() ||
        !metadataStat.isFile() ||
        metadataStat.isSymbolicLink()
      ) {
        throw new Error("Object storage entry is not a regular file");
      }
      assertPrivateFile(dataStat, "Object data file");
      assertPrivateFile(metadataStat, "Object metadata file");
      const [bytes, rawMetadata] = await Promise.all([
        readFile(paths.data),
        readFile(paths.metadata, "utf8"),
      ]);
      const metadata = JSON.parse(rawMetadata) as ObjectMetadata;
      if (createHash("sha256").update(bytes).digest("hex") !== metadata.etag) {
        return null;
      }
      return {
        etag: metadata.etag,
        customMetadata: metadata.customMetadata,
        httpMetadata: metadata.httpMetadata,
        async arrayBuffer() {
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string | string[]): Promise<void> {
    await this.ready;
    for (const item of Array.isArray(key) ? key : [key]) {
      const paths = await this.pathsFor(item, false);
      await Promise.all([
        unlink(paths.data).catch(ignoreMissing),
        unlink(paths.metadata).catch(ignoreMissing),
      ]);
    }
  }

  private async initialize(): Promise<void> {
    await ensureSafeDirectory(this.root);
    await ensureSafeDirectory(this.dataRoot, this.root);
    await ensureSafeDirectory(this.metadataRoot, this.root);
  }

  private async serializeWrite<T>(
    key: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.pendingWrites.set(key, current);
    try {
      return await current;
    } finally {
      if (this.pendingWrites.get(key) === current) {
        this.pendingWrites.delete(key);
      }
    }
  }

  private async pathsFor(key: string, createParents: boolean): Promise<{
    data: string;
    metadata: string;
  }> {
    const parts = validateKey(key);
    const data = join(this.dataRoot, ...parts);
    const metadata = join(this.metadataRoot, ...parts) + ".json";
    if (createParents) {
      await ensureNestedDirectory(dirname(data), this.dataRoot);
      await ensureNestedDirectory(dirname(metadata), this.metadataRoot);
    } else {
      await assertSafeParentPath(dirname(data), this.dataRoot);
      await assertSafeParentPath(dirname(metadata), this.metadataRoot);
    }
    return { data, metadata };
  }
}

async function ensureSafeDirectory(path: string, boundary?: string): Promise<void> {
  const resolved = resolve(path);
  if (boundary && !isWithin(resolved, boundary)) {
    throw new Error("Object storage path escaped its root");
  }
  try {
    const stat = await lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe object storage directory: ${resolved}`);
    }
    assertPrivateDirectory(stat, resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(resolved, { recursive: true, mode: 0o700 });
  }
  const verified = await lstat(resolved);
  if (!verified.isDirectory() || verified.isSymbolicLink()) {
    throw new Error(`Unsafe object storage directory: ${resolved}`);
  }
  assertPrivateDirectory(verified, resolved);
  if ((await realpath(resolved)) !== resolved) {
    throw new Error(`Object storage directory uses a symlink: ${resolved}`);
  }
}

async function ensureNestedDirectory(path: string, boundary: string): Promise<void> {
  const resolvedPath = resolve(path);
  if (!isWithin(resolvedPath, boundary)) {
    throw new Error("Object storage path escaped its root");
  }
  const relative = resolvedPath.slice(resolve(boundary).length + 1);
  let current = resolve(boundary);
  if (!relative) return;
  for (const part of relative.split(sep)) {
    current = join(current, part);
    await ensureSafeDirectory(current, boundary);
  }
}

async function assertSafeParentPath(path: string, boundary: string): Promise<void> {
  const resolvedPath = resolve(path);
  if (!isWithin(resolvedPath, boundary)) {
    throw new Error("Object storage path escaped its root");
  }
  const relative = resolvedPath.slice(resolve(boundary).length + 1);
  let current = resolve(boundary);
  if (!relative) return;
  for (const part of relative.split(sep)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Unsafe object storage directory: ${current}`);
      }
      assertPrivateDirectory(stat, current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function assertPrivateDirectory(
  stat: Stats,
  path: string,
): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Object storage directory must be owned by the runtime user: ${path}`);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`Object storage directory permissions must be 700: ${path}`);
  }
}

function assertPrivateFile(
  stat: Stats,
  label: string,
): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the runtime user`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} permissions must be 600`);
  }
}

function validateKey(key: string): string[] {
  if (!key || key.includes("\\") || key.includes("\0") || key.startsWith("/")) {
    throw new Error("Invalid object storage key");
  }
  const parts = key.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        !/^[A-Za-z0-9._:-]+$/u.test(part),
    )
  ) {
    throw new Error("Invalid object storage key");
  }
  return parts;
}

function isWithin(path: string, boundary: string): boolean {
  const root = resolve(boundary);
  return path === root || path.startsWith(`${root}${sep}`);
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
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

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
