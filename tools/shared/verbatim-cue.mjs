// The one verbatim-cue contract, shared by the local-model
// adapter (tools/local-model), the bridge and routing so they cannot drift.
// Plain JavaScript so the adapter imports it without a TypeScript loader; the
// domain re-exports it from src/domain/cue.ts.
export const CUE_MIN = 8;
export const CUE_MAX = 160;
// The local model reads only this much of the frame text, so a cue can only be
// verbatim within it.
export const CUE_WINDOW = 4096;

export const normalizeWhitespace = (text) => text.replace(/\s+/g, ' ').trim();

// The cue as it appears on the page (normalised), or undefined when it is not a
// verbatim substring of the window or its normalised length is outside 8..160.
export function verbatimCue(text, cue) {
  if (typeof text !== 'string' || typeof cue !== 'string' || cue.length > CUE_WINDOW) return undefined;
  const needle = normalizeWhitespace(cue);
  if (needle.length < CUE_MIN || needle.length > CUE_MAX) return undefined;
  return normalizeWhitespace(text.slice(0, CUE_WINDOW)).includes(needle) ? needle : undefined;
}
