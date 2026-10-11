// Family alert through Messages on the Mac running Shepherd. The
// text is the fixed family template rendered from a closed pattern code and local
// configuration; nothing from the page or a model is ever sent. Missing handle,
// Messages or permission reports 'unavailable', never an error to the person.
import type { Pattern } from '../domain/assessment.ts';
import { familyText, type Persona } from '../domain/templates.ts';
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

  async notify(pattern: Pattern): Promise<FamilyStatus> {
    const { handle, persona } = this.options;
    if (!handle) return 'unavailable';
    const now = (this.options.now ?? Date.now)();
    if (this.last !== undefined && now - this.last < (this.options.cooldown_ms ?? 5 * 60_000)) return 'cooldown';
    let text: string;
    try { text = familyText(pattern, persona, new Date(now), this.options.timeZone); } catch { return 'unavailable'; }
    try {
      const execute = this.options.execute ?? runProcess;
      await execute('/usr/bin/osascript', [...script.flatMap((line) => ['-e', line]), text, handle], Buffer.alloc(0), new AbortController().signal, 10_000, 4096);
      this.last = now;
      return 'sent';
    } catch { return 'unavailable'; }
  }
}
