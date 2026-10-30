import { open } from "node:fs/promises";
import { dirname } from "node:path";

type SyncHandle = {
  writeFile(value: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

type MarkerIo = {
  open(path: string, flags: string, mode?: number): Promise<SyncHandle>;
};

const DEFAULT_IO: MarkerIo = { open };

export async function createDurablePaidRunMarker(
  path: string,
  value: string,
  io: MarkerIo = DEFAULT_IO,
): Promise<void> {
  let marker: SyncHandle;
  try {
    marker = await io.open(path, "wx", 0o600);
  } catch {
    throw new Error("PROVIDER_CANARY_ALREADY_USED");
  }
  try {
    await marker.writeFile(value, "utf8");
    await marker.sync();
  } finally {
    await marker.close();
  }
  const directory = await io.open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
