import { performance } from 'node:perf_hooks';

import type { AnalyzerPort, Capability } from '../application/analyzer.ts';
import { analyzeText, makeUnavailable, POLICY_VERSION, PROMPT_VERSION, SCHEMA_VERSION, type Assessment, type Frame } from '../domain/assessment.ts';
import { decodeFrame } from '../server/frame.ts';
import { runProcess, type ProcessRunner } from './process.ts';

export class OcrAnalyzer implements AnalyzerPort {
  private readonly executable: string;
  private readonly execute: ProcessRunner;

  constructor(options: { executable?: string; execute?: ProcessRunner } = {}) {
    this.executable = options.executable ?? 'tesseract';
    this.execute = options.execute ?? runProcess;
  }

  async capabilities(): Promise<Capability[]> { return [await this.capability()]; }

  private async capability(): Promise<Capability> {
    const result: Capability = { id: 'local-ocr-rules', kind: 'rules', route: 'local', available: false };
    try {
      const signal = new AbortController().signal;
      const version = await this.execute(this.executable, ['--version'], Buffer.alloc(0), signal, 2000, 4096);
      const languages = await this.execute(this.executable, ['--list-langs'], Buffer.alloc(0), signal, 2000, 4096);
      if (!version.startsWith('tesseract ') || !languages.split(/\r?\n/).includes('eng')) throw Error('Missing English OCR');
      return { ...result, available: true, engine_version: version.split('\n')[0].slice(0, 128), limitation: 'English OCR and narrow pressure rules; no model inference or media-origin detection.' };
    } catch { return { ...result, limitation: 'Tesseract with English language data is unavailable.' }; }
  }

  // Text for the rules and later tiers: native frames carry it; pixel frames are OCR'd.
  async extract(frame: Frame, signal: AbortSignal): Promise<string> {
    if ('text' in frame) return frame.text;
    const { png } = decodeFrame(frame);
    if (!png) throw Error('Expected pixels');
    const text = await this.execute(this.executable, ['stdin', 'stdout', '-l', 'eng', '--psm', '6'], png, signal);
    if (signal.aborted || /[\u0000\uFFFD]/.test(text)) throw Error('Invalid OCR output');
    return text;
  }

  async analyze(frame: Frame, signal: AbortSignal): Promise<Assessment> {
    const started = performance.now();
    let result: Assessment;
    try {
      const text = await this.extract(frame, signal);
      result = analyzeText(text, { frame_id: frame.frame_id, source: frame.source }, 'text' in frame ? { url: frame.url } : {});
    } catch { result = makeUnavailable({ frame_id: frame.frame_id, source: frame.source }); }
    const duration_ms = Math.round(performance.now() - started);
    return { ...result, duration_ms, trace: [{
      tier: 'rules', analyzer_id: 'local-ocr-rules', outcome: result.status, duration_ms, remote_calls: 0, bytes_out: 0,
      cost: { known: true, usd: 0 }, cached: false, versions: { policy: POLICY_VERSION, prompt: PROMPT_VERSION, schema: SCHEMA_VERSION },
    }] };
  }
}
