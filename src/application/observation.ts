import type { Assessment, Frame, Source } from '../domain/assessment.ts';
import type { PipelineRecord } from '../domain/pipeline.ts';

export interface ObservationPayload {
  image?: string;
  ocr_text?: string;
  ocr_complete: boolean;
}

// Content-bearing capture data lives only in this record and the private journal.
// Classifier, blocklist and evidence metadata are separate annotations so sources
// can share one observation identity without copying raw OCR into traces.
export interface Observation {
  id: string;
  observed_at: string;
  source: Source;
  frame_id: string;
  session_id?: string;
  generation?: number;
  app?: string | null;
  bundle_id?: string | null;
  window_title?: string | null;
  payload: ObservationPayload;
}

export interface ClassificationAnnotation {
  id: string;
  observation_id: string;
  created_at: string;
  kind: 'classification';
  value: {
    status: Assessment['status']; reasons: Assessment['reasons']; route: Assessment['route']; duration_ms: number;
    analyzer: Assessment['analyzer']; policy_row?: string; pattern?: NonNullable<Assessment['pattern']>; verdict?: NonNullable<Assessment['verdict']>;
  };
}
export interface EvidenceRegionAnnotation { id: string; observation_id: string; created_at: string; kind: 'evidence_region'; value: { count: number } }
export interface BlocklistAnnotation { id: string; observation_id: string; created_at: string; kind: 'blocklist'; value: { tags: string[] } }
export interface PipelineAnnotation { id: string; observation_id: string; created_at: string; kind: 'pipeline'; value: PipelineRecord }
export type ObservationAnnotation = ClassificationAnnotation | EvidenceRegionAnnotation | BlocklistAnnotation | PipelineAnnotation;

export interface ObservationSource {
  readonly id: string;
  start(onObservation: (observation: Observation) => void): () => void;
  stop(): void;
}

export interface ScreenFrameSourceOptions { now?: () => number; id?: () => string }
export class ScreenFrameSource implements ObservationSource {
  readonly id = 'screen-frame';
  private onObservation?: (observation: Observation) => void;
  private readonly now: () => number;
  private readonly makeId: () => string;
  constructor(options: ScreenFrameSourceOptions = {}) { this.now = options.now ?? Date.now; this.makeId = options.id ?? (() => crypto.randomUUID()); }
  start(onObservation: (observation: Observation) => void): () => void { this.onObservation = onObservation; return () => this.stop(); }
  stop(): void { this.onObservation = undefined; }
  observe(frame: Frame, ocr_text: string | undefined, ocr_complete: boolean): Observation {
    const native = 'text' in frame;
    const observation: Observation = {
      id: this.makeId(), observed_at: new Date(this.now()).toISOString(), source: frame.source, frame_id: frame.frame_id,
      ...(frame.session_id === undefined ? {} : { session_id: frame.session_id }),
      ...(frame.generation === undefined ? {} : { generation: frame.generation }),
      ...(native && frame.app !== undefined ? { app: frame.app } : {}),
      ...(native && frame.bundle_id !== undefined ? { bundle_id: frame.bundle_id } : {}),
      ...(native && frame.window_title !== undefined ? { window_title: frame.window_title } : {}),
      payload: { ...(!native ? { image: frame.image } : {}), ...(ocr_text === undefined ? {} : { ocr_text }), ocr_complete },
    };
    this.onObservation?.(observation);
    return observation;
  }
  classification(observation_id: string, assessment: Assessment): ClassificationAnnotation {
    return { id: `${observation_id}:classification`, observation_id, created_at: new Date(this.now()).toISOString(), kind: 'classification',
      value: { status: assessment.status, reasons: assessment.reasons, route: assessment.route, duration_ms: assessment.duration_ms, analyzer: assessment.analyzer, ...(assessment.policy_row ? { policy_row: assessment.policy_row } : {}), ...(assessment.pattern ? { pattern: assessment.pattern } : {}), ...(assessment.verdict ? { verdict: assessment.verdict } : {}) } };
  }
}

// Permissioned source adapters belong to their own beads. These inert shapes let
// the collector be tested without requesting Accessibility or microphone access.
export class AccessibilitySource implements ObservationSource {
  readonly id = 'accessibility';
  start(_onObservation: (observation: Observation) => void): () => void { return () => this.stop(); }
  stop(): void {}
}
export class VoiceSourceStub implements ObservationSource {
  readonly id = 'voice';
  start(_onObservation: (observation: Observation) => void): () => void { return () => this.stop(); }
  stop(): void {}
}

export interface JournalEntry { observation: Observation; annotations: ObservationAnnotation[]; trigger: 'periodic' | 'suspicious' }
// Reads are for the separately authenticated loopback inspector only. Raw PNG
// and OCR must never enter traces, cloud requests, history or family alerts.
export interface JournalRecord {
  id: string;
  captured_at: string;
  source: Source;
  frame_id: string;
  session_id?: string;
  generation?: number;
  app?: string | null;
  bundle_id?: string | null;
  window_title?: string | null;
  ocr_complete: boolean;
  png_path?: string;
  ocr_path?: string;
  trigger: JournalEntry['trigger'];
}
export interface JournalRead { record: JournalRecord; annotations: ObservationAnnotation[]; ocr_text?: string; png: string | null }
// The guard is checked by the storage adapter immediately before it commits
// files, closing the pause/revoke race between queueing and filesystem I/O.
export interface JournalPort {
  write(entry: JournalEntry, current: () => boolean): Promise<void>;
  read(id: string): Promise<JournalRead | undefined>;
  deleteAll(): Promise<void>;
}
export interface ObservationCollectorOptions { now?: () => number; id?: () => string; periodic_ms?: number }

export class ObservationCollector {
  private enabled = false;
  private generation = 0;
  private lastPeriodic = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly periodic: number;
  lastError?: string;
  constructor(private readonly journal: JournalPort, options: ObservationCollectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => crypto.randomUUID());
    this.periodic = options.periodic_ms ?? 600_000;
    if (!Number.isFinite(this.periodic) || this.periodic < 1_000) throw Error('Invalid periodic cadence');
  }
  setEnabled(enabled: boolean): void { this.enabled = enabled; this.generation++; if (!enabled) this.lastError = undefined; }
  get isEnabled(): boolean { return this.enabled; }
  async deleteAll(): Promise<void> { await this.journal.deleteAll(); }
  async observe(observation: Observation, assessment: Assessment, pipeline?: PipelineRecord): Promise<void> {
    if (!this.enabled) return;
    const suspicious = assessment.status === 'concern' || (assessment.status === 'inconclusive' && assessment.reasons.length > 0);
    const periodic = this.now() - this.lastPeriodic >= this.periodic;
    if (!suspicious && !periodic) return;
    if (periodic) this.lastPeriodic = this.now();
    const generation = this.generation;
    const annotation: ClassificationAnnotation = { id: this.id(), observation_id: observation.id, created_at: new Date(this.now()).toISOString(), kind: 'classification',
      value: { status: assessment.status, reasons: assessment.reasons, route: assessment.route, duration_ms: assessment.duration_ms, analyzer: assessment.analyzer, ...(assessment.policy_row ? { policy_row: assessment.policy_row } : {}), ...(assessment.pattern ? { pattern: assessment.pattern } : {}), ...(assessment.verdict ? { verdict: assessment.verdict } : {}) } };
    try {
      const annotations: ObservationAnnotation[] = [annotation, ...(pipeline === undefined ? [] : [{ id: `${observation.id}:pipeline`, observation_id: observation.id, created_at: new Date(this.now()).toISOString(), kind: 'pipeline' as const, value: pipeline }])];
      await this.journal.write({ observation, annotations, trigger: suspicious ? 'suspicious' : 'periodic' },
        () => this.enabled && generation === this.generation);
    } catch { if (this.enabled && generation === this.generation) this.lastError = 'Journal could not save this observation.'; }
  }
}

// Server-facing bridge: the server has the exact submitted frame and final
// assessment; raw artifacts are available only to the local journal inspector.
export interface ObservationRecorder {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  record(frame: Frame, assessment: Assessment, pipeline?: PipelineRecord): Promise<void>;
  deleteAll(): Promise<void>;
}
export class ScreenObservationRecorder implements ObservationRecorder {
  constructor(private readonly source: ScreenFrameSource, private readonly collector: ObservationCollector) {}
  get enabled(): boolean { return this.collector.isEnabled; }
  setEnabled(enabled: boolean): void { this.collector.setEnabled(enabled); }
  async deleteAll(): Promise<void> { await this.collector.deleteAll(); }
  async record(frame: Frame, assessment: Assessment, pipeline?: PipelineRecord): Promise<void> {
    const native = 'text' in frame;
    const observation = this.source.observe(frame, native ? frame.text : undefined, native ? !frame.truncated : false);
    await this.collector.observe(observation, assessment, pipeline);
  }
}
