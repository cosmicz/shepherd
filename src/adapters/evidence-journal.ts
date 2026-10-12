import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { JournalEntry, JournalPort, JournalRead, JournalRecord } from '../application/observation.ts';

export interface EvidenceStorage {
  prepare(path: string): Promise<void>;
  write(path: string, data: string | Buffer, mode: number, current: () => boolean): Promise<void>;
  read(path: string): Promise<string | Buffer | undefined>;
  remove(path: string): Promise<void>;
  clear(path: string): Promise<void>;
}

export class FileEvidenceStorage implements EvidenceStorage {
  async prepare(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); }
  async write(path: string, data: string | Buffer, mode: number, current: () => boolean): Promise<void> {
    if (!current()) return;
    await writeFile(path, data, { mode, flag: 'wx' });
  }
  async read(path: string): Promise<string | Buffer | undefined> {
    try { return await readFile(path); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async remove(path: string): Promise<void> { await rm(path, { force: true }); }
  async clear(path: string): Promise<void> { await rm(path, { recursive: true, force: true }); }
}

function fileID(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw Error('Invalid journal observation id');
  return value;
}
function png(value: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) throw Error('Journal image must be a PNG data URL');
  return Buffer.from(match[1], 'base64');
}

function parseRead(value: string | Buffer): JournalRead {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value)); } catch { throw Error('Invalid journal record'); }
  if (!parsed || typeof parsed !== 'object') throw Error('Invalid journal record');
  const { annotations, ...record } = parsed as { annotations?: unknown } & Record<string, unknown>;
  if (!Array.isArray(annotations) || typeof record.id !== 'string' || typeof record.captured_at !== 'string' || typeof record.source !== 'string' || typeof record.frame_id !== 'string' || typeof record.ocr_complete !== 'boolean' || (record.trigger !== 'periodic' && record.trigger !== 'suspicious')) throw Error('Invalid journal record');
  const session = typeof record.session_id === 'string' ? { session_id: record.session_id } : {};
  const optionalText = (key: 'app' | 'bundle_id' | 'window_title') => typeof record[key] === 'string' || record[key] === null ? { [key]: record[key] as string | null } : {};
  const journalRecord: JournalRecord = {
    id: record.id, captured_at: record.captured_at, source: record.source as JournalRecord['source'], frame_id: record.frame_id,
    ocr_complete: record.ocr_complete, trigger: record.trigger,
    ...session,
    ...(typeof record.generation === 'number' ? { generation: record.generation } : {}),
    ...optionalText('app'), ...optionalText('bundle_id'), ...optionalText('window_title'),
    ...(typeof record.png_path === 'string' ? { png_path: record.png_path } : {}),
    ...(typeof record.ocr_path === 'string' ? { ocr_path: record.ocr_path } : {}),
  };
  return { record: journalRecord, annotations: annotations as JournalRead['annotations'], png: null };
}

// App-private, server-side persistence. Raw artifacts are read only by the
// separately token-authorized loopback inspector, never history or trace SSE.
export class PrivateEvidenceJournal implements JournalPort {
  constructor(private readonly directory: string, private readonly storage: EvidenceStorage = new FileEvidenceStorage()) {
    if (!isAbsolute(directory)) throw Error('Journal directory must be absolute');
  }

  async write(entry: JournalEntry, current: () => boolean): Promise<void> {
    if (!current()) return;
    const id = fileID(entry.observation.id);
    const base = join(this.directory, id);
    if (relative(this.directory, base).startsWith('..')) throw Error('Journal path escapes storage root');
    const image = entry.observation.payload.image;
    const text = entry.observation.payload.ocr_text;
    const record = {
      id, captured_at: entry.observation.observed_at, source: entry.observation.source, frame_id: entry.observation.frame_id,
      ...(entry.observation.session_id === undefined ? {} : { session_id: entry.observation.session_id }),
      ...(entry.observation.generation === undefined ? {} : { generation: entry.observation.generation }),
      ...(entry.observation.app === undefined ? {} : { app: entry.observation.app }),
      ...(entry.observation.bundle_id === undefined ? {} : { bundle_id: entry.observation.bundle_id }),
      ...(entry.observation.window_title === undefined ? {} : { window_title: entry.observation.window_title }),
      ocr_complete: entry.observation.payload.ocr_complete,
      ...(image === undefined ? {} : { png_path: `${id}.png` }),
      ...(text === undefined ? {} : { ocr_path: `${id}.txt` }),
      trigger: entry.trigger, annotations: entry.annotations,
    };
    if (!current()) return;
    await this.storage.prepare(this.directory);
    if (!current()) return;
    const written: string[] = [];
    try {
      if (image !== undefined) { await this.storage.write(`${base}.png`, png(image), 0o600, current); if (current()) written.push(`${base}.png`); }
      if (text !== undefined) { await this.storage.write(`${base}.txt`, text, 0o600, current); if (current()) written.push(`${base}.txt`); }
      if (!current()) { await Promise.all(written.map((path) => this.storage.remove(path))); return; }
      await this.storage.write(`${base}.json`, `${JSON.stringify(record)}\n`, 0o600, current);
    } catch (error) {
      await Promise.all(written.map((path) => this.storage.remove(path)));
      throw error;
    }
  }

  async read(observationId: string): Promise<JournalRead | undefined> {
    const id = fileID(observationId);
    const value = await this.storage.read(join(this.directory, `${id}.json`));
    if (value === undefined) return undefined;
    const entry = parseRead(value);
    const [ocr, image] = await Promise.all([
      entry.record.ocr_path === undefined ? undefined : this.storage.read(join(this.directory, entry.record.ocr_path)),
      entry.record.png_path === undefined ? undefined : this.storage.read(join(this.directory, entry.record.png_path)),
    ]);
    return {
      ...entry,
      ...(ocr === undefined ? {} : { ocr_text: String(ocr) }),
      png: image === undefined ? null : `data:image/png;base64,${Buffer.from(image).toString('base64')}`,
    };
  }

  async deleteAll(): Promise<void> { await this.storage.clear(this.directory); }
}
