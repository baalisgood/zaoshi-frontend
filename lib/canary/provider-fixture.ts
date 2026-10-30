import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export const PROVIDER_CANARY_CONFIRMATION = "ONE_SEEDREAM_45_IMAGE";
export const PROVIDER_CANARY_MODEL = "doubao-seedream-4-5-251128" as const;
export const PROVIDER_CANARY_RUN_ID = "seedream-45-canary-v1";
export const PROVIDER_CANARY_SESSION_TOKEN =
  "provider_canary_session_20260912_fixed";
export const PROVIDER_CANARY_FIXTURE_MIME_TYPE = "image/png" as const;
export const PROVIDER_CANARY_FIXTURE_WIDTH = 480;
export const PROVIDER_CANARY_FIXTURE_HEIGHT = 480;

const bytes = createSyntheticInteriorPng();
export const PROVIDER_CANARY_FIXTURE_BYTES = new Uint8Array(bytes);
export const PROVIDER_CANARY_FIXTURE_BYTE_SIZE = 3315;
export const PROVIDER_CANARY_FIXTURE_SHA256 =
  "e52b5613031ed024b693e31f8a22e08812f269c49f3e4f78dcd3987f5113b282";
if (
  bytes.byteLength !== PROVIDER_CANARY_FIXTURE_BYTE_SIZE ||
  createHash("sha256").update(bytes).digest("hex") !==
    PROVIDER_CANARY_FIXTURE_SHA256
) {
  throw new Error("PROVIDER_CANARY_FIXTURE_METADATA_INVALID");
}

function createSyntheticInteriorPng(): Buffer {
  const width = PROVIDER_CANARY_FIXTURE_WIDTH;
  const height = PROVIDER_CANARY_FIXTURE_HEIGHT;
  const rgba = Buffer.alloc(width * height * 4);
  fill(rgba, width, 0, 0, width, 330, [232, 228, 220, 255]);
  fill(rgba, width, 0, 330, width, 150, [164, 132, 100, 255]);
  fill(rgba, width, 55, 45, 170, 180, [74, 101, 119, 255]);
  fill(rgba, width, 65, 55, 70, 160, [166, 205, 226, 255]);
  fill(rgba, width, 145, 55, 70, 160, [166, 205, 226, 255]);
  fill(rgba, width, 135, 55, 10, 160, [74, 101, 119, 255]);
  fill(rgba, width, 65, 130, 150, 10, [74, 101, 119, 255]);
  fill(rgba, width, 260, 224, 170, 104, [104, 126, 111, 255]);
  fill(rgba, width, 275, 200, 140, 42, [117, 139, 122, 255]);
  fill(rgba, width, 278, 328, 18, 58, [67, 71, 68, 255]);
  fill(rgba, width, 394, 328, 18, 58, [67, 71, 68, 255]);
  fill(rgba, width, 122, 350, 190, 48, [216, 205, 187, 255]);
  fill(rgba, width, 140, 398, 18, 42, [79, 71, 63, 255]);
  fill(rgba, width, 276, 398, 18, 42, [79, 71, 63, 255]);
  fill(rgba, width, 360, 82, 8, 122, [63, 68, 66, 255]);
  fill(rgba, width, 328, 70, 72, 18, [229, 205, 145, 255]);
  fill(rgba, width, 346, 204, 36, 12, [63, 68, 66, 255]);
  fill(rgba, width, 28, 405, 424, 6, [130, 101, 77, 255]);

  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    rgba.copy(scanlines, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function fill(
  target: Buffer,
  width: number,
  x: number,
  y: number,
  rectangleWidth: number,
  rectangleHeight: number,
  color: readonly [number, number, number, number],
): void {
  for (let py = y; py < y + rectangleHeight; py += 1) {
    for (let px = x; px < x + rectangleWidth; px += 1) {
      const offset = (py * width + px) * 4;
      target[offset] = color[0];
      target[offset + 1] = color[1];
      target[offset + 2] = color[2];
      target[offset + 3] = color[3];
    }
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return result;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
