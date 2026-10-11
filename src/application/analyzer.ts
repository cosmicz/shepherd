import type { Analyzer, Assessment, Frame, Route } from '../domain/assessment.ts';

export interface Capability {
  id: Analyzer['id'];
  kind: Analyzer['kind'];
  route: Route;
  available: boolean;
  engine_version?: string;
  model?: string;
  limitation?: string;
}
// Caller abort at any boundary: no Assessment, no event, no speech, no alert.
export class AnalysisCancelled extends Error {
  constructor() { super('Analysis cancelled'); this.name = 'AnalysisCancelled'; }
}

// The client's own deadline expired: a typed failure, never a raw AbortError.
export class AnalysisTimeout extends Error {
  constructor() { super('Analysis timed out'); this.name = 'AnalysisTimeout'; }
}

export interface AnalyzerPort {
  analyze(frame: Frame, signal: AbortSignal): Promise<Assessment>;
  // One entry per analyzer behind this port; a composite reports every tier.
  capabilities(): Promise<Capability[]>;
}
