// On-device voice source (contract): turns the Swift helper's JSON lines
// (tools/shepherd-voice) into transient TextFrames with source 'voice', which
// the same rules and local model assess as screen text. Off until start(); the
// launch boundary is injectable so tests never run the helper or touch the
// microphone. Helper diagnostics and recognised text never appear in an
// unavailable state. No audio passes through this adapter, only text.
import { spawn, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { childEnvironment } from './process.ts';
import type { Observation, ObservationSource } from '../application/observation.ts';
import { parseTextFrame, record, type Envelope, type TextFrame } from '../domain/assessment.ts';

const bundledHelperPath = fileURLToPath(new URL('../../tools/shepherd-voice/build/shepherd-voice', import.meta.url));
// The helper closes a segment at 30 s or 400 characters; t_end is stamped once
// the recogniser's final result arrives, so allow 5 s for finalisation.
export const VOICE_SEGMENT_LIMITS = { max_seconds: 30, finalisation_grace_seconds: 5, max_characters: 400 } as const;
const segmentFields = new Set(['kind', 't_start', 't_end', 'text', 'confidence', 'reason', 'origin']);
// system: the Mac's own audio output (default); microphone: the input device.
export type VoiceOrigin = 'system' | 'microphone';
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;

export interface VoiceSegment { t_start: string; t_end: string; text: string; confidence: number; reason: 'change' | 'interval'; origin: VoiceOrigin }
export interface VoiceUnavailable {
  code: 'no_on_device_model' | 'permission_denied' | 'helper_unavailable' | 'helper_failed' | 'helper_exited';
  message: string;
}
export interface VoiceChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'error' | 'close', listener: (...args: unknown[]) => void): unknown;
}
export type VoiceLauncher = (executable: string, args: string[], options: SpawnOptions) => VoiceChild;

export interface VoiceSourceOptions {
  publish: (frame: TextFrame) => void;
  onUnavailable?: (state: VoiceUnavailable) => void;
  // 'listening' once the helper has the microphone; 'stopped' when it ends.
  onState?: (state: 'listening' | 'stopped') => void;
  launcher?: VoiceLauncher;
  executable?: string;
  locale?: string;
  // Which audio the helper listens to; system audio unless the person chose the microphone.
  input?: VoiceOrigin;
  id?: () => string;
  // Session envelope for each frame; a voice grant must carry source 'voice'.
  envelope?: () => Envelope;
}

const messages: Record<VoiceUnavailable['code'], string> = {
  no_on_device_model: 'On-device speech recognition is not available for this language.',
  permission_denied: 'Microphone or Speech Recognition permission is not granted.',
  helper_unavailable: 'The voice helper is unavailable.',
  helper_failed: 'The voice helper failed.',
  helper_exited: 'The voice helper stopped unexpectedly.',
};
const unavailableCodes: Record<string, VoiceUnavailable['code']> = {
  no_on_device_model: 'no_on_device_model', speech_denied: 'permission_denied', microphone_unavailable: 'permission_denied',
  recognizer_unavailable: 'helper_unavailable', usage: 'helper_unavailable',
  system_audio_denied: 'permission_denied', system_audio_unavailable: 'helper_unavailable',
};
const unavailable = (code: VoiceUnavailable['code']): VoiceUnavailable => ({ code, message: messages[code] });

// Throws on anything outside the segment contract; the caller drops the line.
export function parseSegment(value: Record<string, unknown>): VoiceSegment {
  if (Object.keys(value).some((key) => !segmentFields.has(key))) throw Error('Unknown segment field');
  const { t_start, t_end, text, confidence, reason, origin } = value;
  if (typeof t_start !== 'string' || typeof t_end !== 'string' || !ISO.test(t_start) || !ISO.test(t_end)) throw Error('Invalid segment time');
  const seconds = (Date.parse(t_end) - Date.parse(t_start)) / 1000;
  if (!(seconds >= 0) || seconds > VOICE_SEGMENT_LIMITS.max_seconds + VOICE_SEGMENT_LIMITS.finalisation_grace_seconds) throw Error('Segment out of bounds');
  if (typeof text !== 'string' || !text.trim() || text.length > VOICE_SEGMENT_LIMITS.max_characters) throw Error('Invalid segment text');
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw Error('Invalid confidence');
  if (reason !== 'change' && reason !== 'interval') throw Error('Invalid segment reason');
  if (origin !== 'system' && origin !== 'microphone') throw Error('Invalid segment origin');
  return { t_start, t_end, text, confidence, reason, origin };
}

export class VoiceSource {
  private generation = 0;
  private stopCurrent?: () => void;
  private state: 'idle' | 'listening' = 'idle';
  private droppedLines = 0;
  private liveOrigin?: VoiceOrigin;

  constructor(private readonly options: VoiceSourceOptions) {}

  get listening(): boolean { return this.state === 'listening'; }
  // Helper lines that failed the contract and were discarded (count only).
  get dropped(): number { return this.droppedLines; }
  // The origin the helper reports as live, for the companion's indicator.
  get origin(): VoiceOrigin | undefined { return this.state === 'listening' ? this.liveOrigin : undefined; }

  start(): () => void {
    this.stopCurrent?.();
    const generation = ++this.generation;
    const launch = this.options.launcher ?? ((executable, args, options) => spawn(executable, args, options));
    const executable = this.options.executable ?? process.env.SHEPHERD_VOICE_BIN ?? bundledHelperPath;
    const child = launch(executable, ['--locale', this.options.locale ?? 'en-US', '--input', this.options.input ?? 'system'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment() });
    let lines: ReturnType<typeof createInterface> | undefined;
    let reported = false;
    const current = () => generation === this.generation;
    const report = (state: VoiceUnavailable) => {
      if (!current() || reported) return;
      reported = true;
      this.setState('idle');
      this.options.onUnavailable?.(state);
    };
    const stop = () => {
      if (!current()) return;
      this.generation += 1;
      lines?.close();
      child.kill('SIGTERM');
      this.setState('idle');
    };
    this.stopCurrent = stop;
    if (!child.stdout) report(unavailable('helper_unavailable'));
    else {
      lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => { if (current()) this.handle(line, report); });
    }
    // stderr carries diagnostics only; it is drained and never surfaced.
    child.stderr?.resume();
    child.on('error', () => report(unavailable('helper_unavailable')));
    child.on('close', (code) => {
      if (code !== 0) report(unavailable('helper_exited'));
      else if (current()) this.setState('idle');
    });
    return stop;
  }

  stop(): void { this.stopCurrent?.(); }

  private handle(line: string, report: (state: VoiceUnavailable) => void): void {
    let value: Record<string, unknown>;
    try { value = record(JSON.parse(line)); } catch { this.droppedLines += 1; return; }
    if (value.kind === 'listening') {
      this.liveOrigin = value.origin === 'microphone' ? 'microphone' : 'system';
      this.setState('listening');
      return;
    }
    if (value.kind === 'stopped') { this.setState('idle'); return; }
    if (value.kind === 'unavailable') { report(unavailable(unavailableCodes[String(value.reason)] ?? 'helper_failed')); return; }
    if (value.kind !== 'segment') { this.droppedLines += 1; return; }
    let frame: TextFrame;
    try {
      const segment = parseSegment(value);
      frame = parseTextFrame({ frame_id: this.options.id?.() ?? crypto.randomUUID(), source: 'voice', text: segment.text, captured_at: segment.t_end, voice_origin: segment.origin, ...this.options.envelope?.() });
    } catch { this.droppedLines += 1; return; }
    this.options.publish(frame);
  }

  private setState(next: 'idle' | 'listening'): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onState?.(next === 'listening' ? 'listening' : 'stopped');
  }
}

// su6 port mapping: a voice frame becomes a text-only observation. The payload is
// the recognised text; there is never an image, audio or screen metadata.
export function voiceObservation(frame: TextFrame, id: string): Observation {
  return {
    id, observed_at: frame.captured_at, source: 'voice', frame_id: frame.frame_id,
    ...(frame.session_id === undefined ? {} : { session_id: frame.session_id }),
    ...(frame.generation === undefined ? {} : { generation: frame.generation }),
    payload: { ocr_text: frame.text, ocr_complete: true },
  };
}

export interface VoiceObservationOptions extends Omit<VoiceSourceOptions, 'publish'> {
  observationId?: () => string;
  // Runtime hook: analyse the frame, then give the collector observation and assessment.
  onFrame?: (frame: TextFrame, observation: Observation) => void;
}

// The real voice ObservationSource (replaces su6's inert stub). Off until start().
export class VoiceObservationSource implements ObservationSource {
  readonly id = 'voice';
  onFrame?: (frame: TextFrame, observation: Observation) => void;
  private readonly helper: VoiceSource;
  private onObservation?: (observation: Observation) => void;
  private stopHelper?: () => void;

  constructor(private readonly options: VoiceObservationOptions = {}) {
    this.onFrame = options.onFrame;
    this.helper = new VoiceSource({ ...options, publish: (frame) => this.publish(frame) });
  }

  get listening(): boolean { return this.helper.listening; }

  start(onObservation: (observation: Observation) => void): () => void {
    this.onObservation = onObservation;
    this.stopHelper = this.helper.start();
    return () => this.stop();
  }

  stop(): void {
    this.onObservation = undefined;
    this.stopHelper?.();
    this.stopHelper = undefined;
  }

  private publish(frame: TextFrame): void {
    if (!this.onObservation) return;
    const observation = voiceObservation(frame, this.options.observationId?.() ?? crypto.randomUUID());
    this.onObservation(observation);
    this.onFrame?.(frame, observation);
  }
}
