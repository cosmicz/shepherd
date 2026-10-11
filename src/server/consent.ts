// Server-side grant registry: the live authority for cloud consent.
// A grant carried by a frame counts only while the companion's registration is
// held here unrevoked and identical. Revocation is final for that grant id, so a
// replayed id never becomes live again, and it aborts any analysis using it.
import { isDeepStrictEqual } from 'node:util';

import type { ConsentPort } from '../application/routing.ts';
import { checkGrant, parseGrant, type Frame, type Grant } from '../domain/assessment.ts';

export class GrantError extends Error {
  constructor(readonly status: 400 | 404 | 409) { super('Grant rejected'); }
}

export class GrantRegistry implements ConsentPort {
  private readonly grants = new Map<string, Grant>();
  private readonly revoked = new Set<string>();
  private readonly listeners = new Set<(id: string) => void>();

  register(input: unknown): Grant {
    let grant: Grant;
    try { grant = parseGrant(input); } catch { throw new GrantError(400); }
    if (this.revoked.has(grant.id)) throw new GrantError(409);
    const existing = this.grants.get(grant.id);
    if (existing && !isDeepStrictEqual(existing, grant)) throw new GrantError(409);
    this.grants.set(grant.id, grant);
    return grant;
  }

  revoke(id: string): void {
    if (!this.grants.has(id) && !this.revoked.has(id)) throw new GrantError(404);
    this.grants.delete(id);
    this.revoked.add(id);
    for (const listener of this.listeners) listener(id);
  }

  onRevoke(listener: (id: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  live(frame: Frame, now: number): boolean {
    const carried = frame.consent;
    if (!carried || this.revoked.has(carried.id)) return false;
    const held = this.grants.get(carried.id);
    return !!held && isDeepStrictEqual(held, carried) && checkGrant(frame, now) === 'ok';
  }
}
