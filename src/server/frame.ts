import { boundedString, oneOf, parseEnvelope, parseTextFrame, record, sources, type Frame, type PngFrame } from '../domain/assessment.ts';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_SIDE = 5120;
export const MAX_PIXELS = 10_000_000;
const PREFIX = 'data:image/png;base64,';
const MAX_IMAGE_CHARS = PREFIX.length + Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
// The request cap is derived from the image cap: a maximal data URL plus a small
// allowance for the JSON envelope (keys, frame_id <= 128, source).
const ENVELOPE_BYTES = 64 * 1024;
export const MAX_BODY_BYTES = MAX_IMAGE_CHARS + ENVELOPE_BYTES;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Linear base64 validation. A grouped repeating regex overflowed V8's stack near
// 3.3 MiB (F1). The canonical round trip rejects characters outside the standard
// alphabet (including base64url), whitespace, missing or misplaced padding and
// non-zero pad bits, because Buffer's lenient decoder never re-encodes to them.
function decodeBase64(encoded: string): Buffer {
  if (!encoded.length || encoded.length % 4 !== 0) throw Error('Invalid base64');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw Error('Invalid base64');
  return bytes;
}

export interface DecodedFrame { frame: Frame; png?: Buffer; pixels?: { width: number; height: number } }

// Accepts either variant: a TextFrame from a local helper (source 'native' or
// 'voice', no pixels) or a PNG capture frame from the browser (any other source).
export function decodeFrame(input: unknown): DecodedFrame {
  const value = record(input);
  if (value.source === 'native' || value.source === 'voice') return { frame: parseTextFrame(value) };
  return decodePngFrame(value);
}

export function decodePngFrame(value: Record<string, unknown>): { frame: PngFrame; png: Buffer; pixels: { width: number; height: number } } {
  const frame_id = boundedString(value.frame_id);
  const source = oneOf(value.source, sources.filter((item) => item !== 'native' && item !== 'voice'));
  const envelope = parseEnvelope(value);
  const image = boundedString(value.image, MAX_IMAGE_CHARS);
  if (!image.startsWith(PREFIX)) throw Error('Expected a PNG data URL');
  const png = decodeBase64(image.slice(PREFIX.length));
  if (png.length > MAX_IMAGE_BYTES || png.length < 45 || !png.subarray(0, 8).equals(signature)) throw Error('Invalid PNG');
  if (png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR') throw Error('Missing PNG header');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw Error('Image dimensions exceed limit');
  let cursor = 8;
  let data = false;
  let ended = false;
  while (cursor + 12 <= png.length) {
    const length = png.readUInt32BE(cursor);
    const type = png.toString('ascii', cursor + 4, cursor + 8);
    if (length > png.length - cursor - 12 || type === 'acTL') throw Error('Invalid or animated PNG');
    if (type === 'IDAT') data = true;
    cursor += length + 12;
    if (type === 'IEND') { ended = length === 0; break; }
  }
  if (!data || !ended || cursor !== png.length) throw Error('Truncated or trailing PNG data');
  return { frame: { frame_id, source, ...envelope, image }, png, pixels: { width, height } };
}
