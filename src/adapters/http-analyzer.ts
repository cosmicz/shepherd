import { AnalysisCancelled, type AnalyzerPort, type Capability } from '../application/analyzer.ts';
import { analyzerIds, boundedString, oneOf, parseAssessment, record, routes, type Assessment, type Frame } from '../domain/assessment.ts';

export class HttpAnalyzer implements AnalyzerPort {
  constructor(private readonly origin: string) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || new URL(origin).origin !== origin) throw Error('Expected the local Shepherd origin');
  }

  async analyze(frame: Frame, signal: AbortSignal): Promise<Assessment> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    const session = await fetch(`${this.origin}/api/session`, { signal: bounded, redirect: 'error', credentials: 'omit' });
    if (!session.ok) throw Error('Local session unavailable');
    const token = boundedString(record(await session.json()).token, 64);
    const response = await fetch(`${this.origin}/api/analyze`, {
      method: 'POST', signal: bounded, redirect: 'error', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-Shepherd-Token': token, Origin: this.origin },
      body: JSON.stringify(frame),
    });
    // 204: the runtime cancelled the analysis (pause, revocation); there is no result.
    if (response.status === 204) throw new AnalysisCancelled();
    if (!response.ok) throw Error('Local analysis unavailable');
    const result = parseAssessment(await response.json());
    if (result.frame_id !== frame.frame_id || result.source !== frame.source) throw Error('Mismatched analysis response');
    return result;
  }

  // Every analyzer the runtime reports, validated one by one; malformed entries
  // are dropped and an unreachable runtime reports none.
  async capabilities(): Promise<Capability[]> {
    try {
      const response = await fetch(`${this.origin}/api/capabilities`, { signal: AbortSignal.timeout(5000), redirect: 'error', credentials: 'omit' });
      if (!response.ok) return [];
      const body = record(await response.json());
      if (!Array.isArray(body.analyzers) || body.analyzers.length > analyzerIds.length) return [];
      return body.analyzers.flatMap((entry): Capability[] => {
        try {
          const value = record(entry);
          const id = oneOf(value.id, analyzerIds);
          const kind = id === 'local-ocr-rules' ? 'rules' : 'model';
          const route = oneOf(value.route, routes);
          if (value.kind !== kind || route !== { 'local-ocr-rules': 'local', 'local-model': 'local-model', 'cloud-judge': 'cloud' }[id] || typeof value.available !== 'boolean') return [];
          return [{ id, kind, route, available: value.available,
            ...(value.engine_version === undefined ? {} : { engine_version: boundedString(value.engine_version) }),
            ...(value.model === undefined ? {} : { model: boundedString(value.model) }),
            ...(value.limitation === undefined ? {} : { limitation: boundedString(value.limitation, 512) }),
          }];
        } catch { return []; }
      });
    } catch { return []; }
  }
}
