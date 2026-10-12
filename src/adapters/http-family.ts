// Browser-side family alert: sends only the closed pattern and medium codes to
// the local runtime, which renders the fixed template and owns the Messages handle.
import { boundedString, oneOf, record, type Pattern } from '../domain/assessment.ts';
import type { Medium, SpeechKind } from '../domain/templates.ts';

export class HttpFamilyAlert {
  constructor(private readonly origin: string) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || new URL(origin).origin !== origin) throw Error('Expected the local Shepherd origin');
  }

  notify(pattern: Pattern, medium: Medium = 'screen'): Promise<'sent' | 'unavailable' | 'cooldown'> { return this.post('/api/family-alert', { pattern, medium }); }

  // Native banner (x3k): closed codes only; resolves with the person's choice.
  async banner(kind: SpeechKind, pattern: Pattern, medium: Medium = 'screen'): Promise<'call' | 'fine' | 'timeout' | 'busy' | 'unavailable'> {
    try {
      const value = record(await this.request('/api/banner', { kind, pattern, medium }));
      return oneOf(value.action, ['call', 'fine', 'timeout', 'busy', 'unavailable'] as const);
    } catch { return 'unavailable'; }
  }

  // Configuration check: the runtime sends its fixed test message.
  async test(): Promise<'sent' | 'unavailable'> {
    const status = await this.post('/api/family-alert/test', {});
    return status === 'sent' ? 'sent' : 'unavailable';
  }

  private async post(path: string, body: unknown): Promise<'sent' | 'unavailable' | 'cooldown'> {
    try {
      return oneOf(record(await this.request(path, body)).status, ['sent', 'unavailable', 'cooldown'] as const);
    } catch { return 'unavailable'; }
  }

  private async request(path: string, body: unknown): Promise<unknown> {
    const session = await fetch(`${this.origin}/api/session`, { redirect: 'error', credentials: 'omit' });
    const token = boundedString(record(await session.json()).token, 64);
    const response = await fetch(`${this.origin}${path}`, {
      method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-Shepherd-Token': token, Origin: this.origin },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    return response.json();
  }
}
