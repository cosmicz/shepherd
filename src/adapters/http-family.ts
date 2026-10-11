// Browser-side family alert: sends only the closed pattern code to the local
// runtime, which renders the fixed template and owns the Messages handle.
import { boundedString, oneOf, record, type Pattern } from '../domain/assessment.ts';

export class HttpFamilyAlert {
  constructor(private readonly origin: string) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || new URL(origin).origin !== origin) throw Error('Expected the local Shepherd origin');
  }

  notify(pattern: Pattern): Promise<'sent' | 'unavailable' | 'cooldown'> { return this.post('/api/family-alert', { pattern }); }

  // Configuration check: the runtime sends its fixed test message.
  async test(): Promise<'sent' | 'unavailable'> {
    const status = await this.post('/api/family-alert/test', {});
    return status === 'sent' ? 'sent' : 'unavailable';
  }

  private async post(path: string, body: unknown): Promise<'sent' | 'unavailable' | 'cooldown'> {
    try {
      const session = await fetch(`${this.origin}/api/session`, { redirect: 'error', credentials: 'omit' });
      const token = boundedString(record(await session.json()).token, 64);
      const response = await fetch(`${this.origin}${path}`, {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'X-Shepherd-Token': token, Origin: this.origin },
        body: JSON.stringify(body),
      });
      if (!response.ok) return 'unavailable';
      return oneOf(record(await response.json()).status, ['sent', 'unavailable', 'cooldown'] as const);
    } catch { return 'unavailable'; }
  }
}
