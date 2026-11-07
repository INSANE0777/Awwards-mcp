import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { isValidPngBuffer } from "../src/atlas/artifacts.js";

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function png(options: {
  bitDepth: number;
  colorType: number;
  palette?: Buffer[];
  pixels?: Buffer;
  interlaced?: boolean;
}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = options.bitDepth;
  header[9] = options.colorType;
  header[10] = 0;
  header[11] = 0;
  header[12] = options.interlaced ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...(options.palette ?? []).map((entries) => chunk("PLTE", entries)),
    chunk("IDAT", deflateSync(options.pixels ?? Buffer.from([0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("Atlas PNG validation", () => {
  it("accepts an indexed PNG with a palette within bit depth", () => {
    expect(
      isValidPngBuffer(
        png({ bitDepth: 1, colorType: 3, palette: [Buffer.from([0, 0, 0, 255, 255, 255])] }),
      ),
    ).toBe(true);
  });

  it("rejects a palette with more entries than the bit depth allows", () => {
    const buffer = png({
      bitDepth: 1,
      colorType: 3,
      palette: [Buffer.from([0, 0, 0, 255, 255, 255, 128, 128, 128])],
    });
    expect(isValidPngBuffer(buffer)).toBe(false);
  });

  it("rejects repeated PLTE chunks", () => {
    const buffer = png({
      bitDepth: 8,
      colorType: 3,
      palette: [Buffer.from([0, 0, 0, 255, 255, 255]), Buffer.from([0, 0, 0])],
    });
    expect(isValidPngBuffer(buffer)).toBe(false);
  });

  it("rejects interlaced PNGs only after a valid noninterlaced control", () => {
    const pixels = Buffer.from([0, 10, 20, 30]);
    expect(isValidPngBuffer(png({ bitDepth: 8, colorType: 2, pixels }))).toBe(true);
    expect(isValidPngBuffer(png({ bitDepth: 8, colorType: 2, pixels, interlaced: true }))).toBe(
      false,
    );
  });
});
