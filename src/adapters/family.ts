// Family alert through Messages on the Mac running Shepherd (contract). The
// text is the fixed family template rendered from a closed pattern code and local
// configuration; nothing from the page or a model is ever sent. Missing handle,
// Messages or permission reports 'unavailable', never an error to the person.
import type { Pattern } from '../domain/assessment.ts';
import { familyTestText, familyText, type Medium, type Persona } from '../domain/templates.ts';
import { runProcess, type ProcessRunner } from './process.ts';

export type FamilyStatus = 'sent' | 'unavailable' | 'cooldown';

// The message and handle travel as argv, never interpolated into the script.
const script = [
  'on run argv',
  'tell application "Messages" to send (item 1 of argv) to participant (item 2 of argv) of (1st account whose service type = iMessage)',
  'end run',
];

export class MessagesFamilyAlert {
  private last?: number;
  constructor(private readonly options: {
    handle?: string; persona: Persona; timeZone?: string; cooldown_ms?: number;
    execute?: ProcessRunner; now?: () => number;
  }) {}

  get configured(): boolean { return !!this.options.handle; }

  // Configuration check (d3l Prelint): a fixed test message, no cooldown.
  async test(): Promise<'sent' | 'unavailable'> {
    if (!this.options.handle) return 'unavailable';
    let text: string;
    try { text = familyTestText(this.options.persona); } catch { return 'unavailable'; }
    return this.send(text, this.options.handle);
  }

  private async send(text: string, handle: string): Promise<'sent' | 'unavailable'> {
    try {
      const execute = this.options.execute ?? runProcess;
      await execute('/usr/bin/osascript', [...script.flatMap((line) => ['-e', line]), text, handle], Buffer.alloc(0), new AbortController().signal, 10_000, 4096);
      return 'sent';
    } catch { return 'unavailable'; }
  }

  // medium picks the fixed screen or voice template (hf8); the cooldown is shared.
  async notify(pattern: Pattern, medium: Medium = 'screen'): Promise<FamilyStatus> {
    const { handle, persona } = this.options;
    if (!handle) return 'unavailable';
    const now = (this.options.now ?? Date.now)();
    if (this.last !== undefined && now - this.last < (this.options.cooldown_ms ?? 5 * 60_000)) return 'cooldown';
    let text: string;
    try { text = familyText(pattern, persona, new Date(now), this.options.timeZone, medium); } catch { return 'unavailable'; }
    const status = await this.send(text, handle);
    if (status === 'sent') this.last = now;
    return status;
  }
}
