// Structurally valid PNGs of any size without an encoder: decodeFrame checks the
// signature, IHDR and chunk framing, not CRCs or IDAT contents.
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const overhead = 8 + (12 + 13) + 12 + 12;

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  return out;
}

export function syntheticPng(width: number, height: number, total = 4096): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', Buffer.alloc(total - overhead, 7)), chunk('IEND', Buffer.alloc(0))]);
}

export const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
