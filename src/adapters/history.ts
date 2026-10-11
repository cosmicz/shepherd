import { parseEvent, type EventSummary } from '../domain/assessment.ts';

export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const key = 'shepherd.history.v1';
const limit = 100;

export class LocalHistory {
  constructor(private readonly storage: StoragePort) {}

  list(): EventSummary[] {
    let raw: string | null;
    try { raw = this.storage.getItem(key); } catch { throw Error('Local history is unavailable'); }
    if (!raw) return [];
    if (raw.length > 100_000) throw Error('Local history exceeds its storage limit; clear history');
    let values: unknown;
    try { values = JSON.parse(raw); } catch { throw Error('Local history is unreadable; clear history'); }
    if (!Array.isArray(values)) throw Error('Local history is unreadable; clear history');
    return values.slice(0, limit).flatMap((value) => {
      try { return [parseEvent(value)]; } catch { return []; }
    });
  }

  append(event: EventSummary): void {
    const clean = parseEvent(event);
    const events = [clean, ...this.list().filter((item) => item.id !== clean.id)].slice(0, limit);
    try { this.storage.setItem(key, JSON.stringify(events)); } catch { throw Error('Local history could not be saved'); }
  }

  clear(): void {
    try { this.storage.removeItem(key); } catch { throw Error('Local history could not be cleared'); }
  }
}
