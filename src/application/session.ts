import { AnalysisCancelled } from './analyzer.ts';
import { patternOf, speechKind, speechText, type Persona } from '../domain/templates.ts';
import { makeUnavailable, parseAssessment, toEvent, type Assessment, type EventSummary, type Frame, type Pattern, type Source } from '../domain/assessment.ts';

export interface CaptureHandle {
  source: Source;
  frame(): Promise<Frame>;
  stop(): void;
  onEnded(callback: () => void): void;
}
export interface SessionPorts {
  analyze(frame: Frame, signal: AbortSignal): Promise<Assessment>;
  append(event: EventSummary): void;
  speak(message: string): void;
  cancelSpeech(): void;
  onChange(state: Readonly<SessionState>): void;
  now?: () => number;
  id?: () => string;
  interval_ms?: number;
  cooldown_ms?: number;
  // Local configuration for fixed templates (ztq); never model or page text.
  persona?: Persona;
  // Family alert through the local runtime; receives a closed pattern code only.
  notifyFamily?: (pattern: Pattern) => Promise<unknown>;
}
export interface SessionState {
  phase: 'idle' | 'requesting' | 'active' | 'paused';
  generation: number;
  assessment: Assessment | null;
  error: string | null;
}

export class Session {
  private current: SessionState = { phase: 'idle', generation: 0, assessment: null, error: null };
  private capture?: CaptureHandle;
  private abort?: AbortController;
  private inFlight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private preferences = { history: false, speech: false, family: false };
  private lastNotification?: { signature: string; at: number };
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly interval: number;
  private readonly cooldown: number;

  constructor(private readonly ports: SessionPorts) {
    this.now = ports.now ?? Date.now;
    this.id = ports.id ?? (() => crypto.randomUUID());
    this.interval = ports.interval_ms ?? 0;
    this.cooldown = ports.cooldown_ms ?? 60_000;
    if (![this.interval, this.cooldown].every((value) => Number.isFinite(value) && value >= 0)) throw Error('Invalid session timing');
  }
  get state(): Readonly<SessionState> { return structuredClone(this.current); }

  setPreferences(preferences: { history: boolean; speech: boolean; family?: boolean }): void {
    this.preferences = { family: false, ...preferences };
    if (!preferences.speech) this.ports.cancelSpeech();
  }

  private changed(): void { this.ports.onChange(this.state); }
  private active(generation: number): boolean { return this.current.generation === generation && this.current.phase === 'active'; }

  private invalidate(): void {
    this.current = { phase: 'paused', generation: this.current.generation + 1, assessment: null, error: null };
    clearTimeout(this.timer);
    this.abort?.abort();
    const capture = this.capture;
    this.capture = undefined;
    try { capture?.stop(); } catch { this.current.error = 'Capture could not be stopped; close the shared window.'; }
    try { this.ports.cancelSpeech(); } catch { this.current.error = 'Speech could not be cancelled.'; }
  }

  pause(): void { this.invalidate(); this.changed(); }

  async start(select: () => Promise<CaptureHandle>): Promise<void> {
    this.invalidate();
    this.lastNotification = undefined;
    const generation = this.current.generation;
    this.current.phase = 'requesting';
    this.changed();
    let capture: CaptureHandle;
    try { capture = await select(); } catch {
      if (generation === this.current.generation) {
        this.current.phase = 'idle';
        this.current.error = 'Capture permission was denied or the source is unavailable.';
        this.changed();
      }
      return;
    }
    if (generation !== this.current.generation) { capture.stop(); return; }
    this.capture = capture;
    this.current.phase = 'active';
    capture.onEnded(() => { if (this.active(generation)) this.pause(); });
    this.changed();
    // A replacement waits for an old, aborting adapter to settle: no screenshot queue.
    await this.inFlight;
    if (this.active(generation)) await this.analyzeNow();
  }

  async analyzeNow(): Promise<void> {
    if (this.inFlight || !this.capture || this.current.phase !== 'active') return;
    clearTimeout(this.timer);
    const generation = this.current.generation;
    this.abort = new AbortController();
    const work = this.analyze(this.capture, generation, this.abort.signal);
    this.inFlight = work;
    try { await work; } finally {
      this.inFlight = undefined;
      if (this.active(generation) && this.interval > 0) this.timer = setTimeout(() => { void this.analyzeNow(); }, this.interval);
    }
  }

  private async analyze(capture: CaptureHandle, generation: number, signal: AbortSignal): Promise<void> {
    let frame: Frame = { frame_id: this.id(), source: capture.source, image: '' };
    let assessment: Assessment;
    try {
      frame = await capture.frame();
      if (!this.active(generation)) return;
      if (frame.source !== capture.source) throw Error('Mismatched source');
      assessment = parseAssessment(await this.ports.analyze(frame, signal));
      if (assessment.frame_id !== frame.frame_id || assessment.source !== frame.source) throw Error('Mismatched result');
    } catch (error) {
      // A cancelled analysis is discarded: no assessment, history, speech or alert.
      if (error instanceof AnalysisCancelled) return;
      assessment = makeUnavailable({ frame_id: frame.frame_id, source: capture.source });
    }
    if (!this.active(generation)) return;
    this.current.assessment = assessment;
    this.current.error = null;
    this.changed();
    if (!this.active(generation)) return;
    this.publish(assessment, generation);
  }

  private publish(assessment: Assessment, generation: number): void {
    const signature = `${assessment.source}:${assessment.status}:${assessment.reasons.join(',')}`;
    const at = this.now();
    if (this.lastNotification?.signature === signature && at - this.lastNotification.at < this.cooldown) return;
    this.lastNotification = { signature, at };
    if (this.preferences.history) {
      try { this.ports.append(toEvent(assessment, 'shown', this.id(), new Date(at).toISOString())); }
      catch { this.current.error = 'Local history could not be saved. The current assessment is still available.'; this.changed(); }
    }
    const kind = speechKind(assessment);
    if (this.active(generation) && this.preferences.speech && kind) {
      // Spoken words come from the fixed templates; without a configured family
      // name the scam template is rejected and the cautionary one is spoken.
      const pattern = patternOf(assessment);
      const persona = this.ports.persona ?? {};
      let text: string;
      try { text = speechText(kind, pattern, persona); } catch { text = speechText('suspicious', pattern, persona); }
      try { this.ports.speak(text); }
      catch { this.current.error = 'Local speech is unavailable. Read the assessment on screen.'; this.changed(); }
    }
    // Family alert: concerns only (rows 3, 7, 13, 14), under the same cooldown as
    // speech; failures stay silent to the person.
    if (this.active(generation) && this.preferences.family && kind && this.ports.notifyFamily) {
      void this.ports.notifyFamily(patternOf(assessment)).catch(() => undefined);
    }
  }
}
