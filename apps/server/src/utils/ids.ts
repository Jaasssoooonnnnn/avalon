/** Per-game deterministic id generation (keeps event/request ids reproducible). */

export class IdGen {
  private counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${n.toString().padStart(4, "0")}`;
  }

  /** Advance counters past any `prefix_NNNN` ids seen, so a restored game won't collide. */
  prime(ids: Iterable<string>): void {
    for (const id of ids) {
      const m = /^([A-Za-z]+)_(\d+)/.exec(id);
      if (!m) continue;
      const prefix = m[1]!;
      const n = parseInt(m[2]!, 10);
      if (n > (this.counters.get(prefix) ?? 0)) this.counters.set(prefix, n);
    }
  }
}

let gameSeq = 0;

/** Game ids are globally unique within a server process. */
export function genGameId(): string {
  gameSeq += 1;
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `game_${gameSeq.toString().padStart(3, "0")}_${rand}`;
}

/** After loading persisted games, advance the seq past the highest seen. */
export function bumpGameSeq(ids: Iterable<string>): void {
  for (const id of ids) {
    const m = /^game_(\d+)_/.exec(id);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > gameSeq) gameSeq = n;
    }
  }
}
