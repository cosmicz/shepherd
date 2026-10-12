import { loadSnapshot } from '../../tools/threat-intel/threat-intel.mjs';
import type { Frame } from '../domain/assessment.ts';

export interface ThreatTag {
  kind: 'listed'; host: string; lists: string[]; source: 'url' | 'ocr-mention';
  feed_source: string; revision: string; retrieved_at: string; freshness: 'fresh' | 'stale';
  indicator_only: true;
}
type Snapshot = { status: 'fresh' | 'stale'; manifest: { source: string; revision: string; retrieved_at: string }; index: Map<string, string[]> };
const leading = (text: string) => text.split(/\r?\n/, 8).join('\n').slice(0, 2048);
function hostOf(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.hostname.toLowerCase().replace(/\.+$/, '') : undefined; }
  catch { return undefined; }
}

/** Trace-only evidence: never changes reasons, routing, consent or model inputs. */
export class ThreatTraceTagger {
  private pending?: { id: string; text: string; at: number };
  constructor(private readonly snapshot: Snapshot, private readonly ocr = false) {}

  // Keep only the bounded leading OCR text for one in-flight pixel frame; no second OCR.
  remember(frame: Frame, text: string): void {
    if (this.ocr && !('text' in frame)) this.pending = { id: frame.frame_id, text: leading(text), at: Date.now() };
  }

  tags(frame: Frame | undefined): ThreatTag[] {
    if (!frame || frame.source === 'voice') return [];
    const url = 'text' in frame ? frame.url : undefined;
    let source: 'url' | 'ocr-mention' = 'url';
    let hosts: string[] = [];
    if (url) { const host = hostOf(url); if (host) hosts = [host]; }
    else if (this.ocr) {
      source = 'ocr-mention';
      let text = 'text' in frame ? leading(frame.text) : '';
      if (this.pending?.id === frame.frame_id) {
        if (Date.now() - this.pending.at < 30_000) text = this.pending.text;
        this.pending = undefined;
      }
      // OCR is only a mention, never proof of the active destination. Explicit opt-in.
      hosts = [...text.matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,63})\b/gi)].map((m) => m[1].toLowerCase());
    }
    const { manifest } = this.snapshot;
    const timestamp = Date.parse(manifest.retrieved_at);
    const freshness = !Number.isFinite(timestamp) || timestamp > Date.now() || Date.now() - timestamp > 7 * 86400_000 ? 'stale' : this.snapshot.status;
    return [...new Set(hosts)].slice(0, 12).flatMap((host): ThreatTag[] => {
      const lists = this.snapshot.index.get(host);
      return lists ? [{ kind: 'listed', host, lists: [...lists], source, feed_source: manifest.source,
        revision: manifest.revision, retrieved_at: manifest.retrieved_at, freshness, indicator_only: true }] : [];
    });
  }
}

export async function loadThreatTraceTagger(storage: string, ocr = false): Promise<ThreatTraceTagger | undefined> {
  const snapshot = await loadSnapshot(storage);
  return snapshot.status === 'fresh' || snapshot.status === 'stale' ? new ThreatTraceTagger(snapshot, ocr) : undefined;
}
