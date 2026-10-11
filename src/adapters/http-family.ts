// Browser-side family alert: sends only the closed pattern code to the local
// runtime, which renders the fixed template and owns the Messages handle.
import { boundedString, oneOf, record, type Pattern } from '../domain/assessment.ts';

export class HttpFamilyAlert {
  constructor(private readonly origin: string) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || new URL(origin).origin !== origin) throw Error('Expected the local Shepherd origin');
  }

  async notify(pattern: Pattern): Promise<'sent' | 'unavailable' | 'cooldown'> {
    try {
      const session = await fetch(`${this.origin}/api/session`, { redirect: 'error', credentials: 'omit' });
      const token = boundedString(record(await session.json()).token, 64);
      const response = await fetch(`${this.origin}/api/family-alert`, {
        method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'X-Shepherd-Token': token, Origin: this.origin },
        body: JSON.stringify({ pattern }),
      });
      if (!response.ok) return 'unavailable';
      return oneOf(record(await response.json()).status, ['sent', 'unavailable', 'cooldown'] as const);
    } catch { return 'unavailable'; }
  }
}
