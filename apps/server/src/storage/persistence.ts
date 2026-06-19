/**
 * Disk persistence for games. Each game is stored as a single JSON file
 * (the full event-sourced GameState) at <dataDir>/<game_id>.json, so games
 * survive server restarts and can be reloaded for review and export.
 *
 * Writes are atomic (temp file + rename). Corrupt files are skipped on load.
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GameState } from "@avalon/shared";

export class GamePersistence {
  constructor(
    private readonly dir: string,
    private readonly enabled: boolean,
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  private fileFor(gameId: string): string {
    return join(this.dir, `${gameId}.json`);
  }

  async ensureDir(): Promise<void> {
    if (!this.enabled) return;
    await mkdir(this.dir, { recursive: true });
  }

  /** Atomically write the game's full state to disk. */
  async save(state: GameState): Promise<void> {
    if (!this.enabled) return;
    await mkdir(this.dir, { recursive: true });
    const target = this.fileFor(state.game_id);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, target);
  }

  /** Load every persisted game state. Skips files that fail to parse. */
  async loadAll(): Promise<GameState[]> {
    if (!this.enabled) return [];
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: GameState[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(this.dir, name), "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Accept either a bare GameState (our own snapshots) or an exported
        // bundle (which wraps the state in `final_state`), so users can drop an
        // exported game straight into the data dir to recover it.
        const candidate = (parsed?.final_state ?? parsed) as GameState;
        if (candidate && typeof candidate.game_id === "string" && Array.isArray(candidate.event_log)) {
          out.push(candidate);
        }
      } catch {
        // skip corrupt file
      }
    }
    return out;
  }

  async remove(gameId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await unlink(this.fileFor(gameId));
    } catch {
      // already gone
    }
  }
}
