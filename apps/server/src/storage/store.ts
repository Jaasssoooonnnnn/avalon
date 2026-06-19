/**
 * In-memory game registry with disk persistence. Each game's full event-sourced
 * GameState is written to <dataDir>/<id>.json (debounced on change, flushed on
 * game over) and reloaded on startup, so games survive restarts for review.
 */

import {
  SEAT_ORDER,
  defaultConfig,
  type GameConfig,
  type PartialGameConfig,
} from "@avalon/shared";
import type { ServerConfig } from "../config.js";
import { GameController } from "../controller/controller.js";
import { bumpGameSeq, genGameId } from "../utils/ids.js";
import { GamePersistence } from "./persistence.js";

const SAVE_DEBOUNCE_MS = 600;

export class GameStore {
  private games = new Map<string, GameController>();
  private persistence: GamePersistence;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly server: ServerConfig) {
    this.persistence = new GamePersistence(server.dataDir, server.persist);
  }

  /** Load persisted games into memory. Call once at startup. */
  async init(): Promise<void> {
    await this.persistence.ensureDir();
    const states = await this.persistence.loadAll();
    for (const state of states) {
      const controller = GameController.restore(state, this.server);
      this.attach(controller);
      this.games.set(state.game_id, controller);
    }
    bumpGameSeq(states.map((s) => s.game_id));
  }

  create(partial?: PartialGameConfig): GameController {
    const { seats: partialSeats, ...rest } = partial ?? {};
    const config: GameConfig = { ...defaultConfig(), ...rest };
    if (partialSeats) {
      const merged = { ...defaultConfig().seats };
      for (const id of SEAT_ORDER) {
        const m = partialSeats[id];
        if (m) merged[id] = m;
      }
      config.seats = merged;
    }
    const id = genGameId();
    const controller = new GameController(id, config, this.server);
    this.attach(controller);
    this.games.set(id, controller);
    void this.flush(controller); // write the initial state immediately
    return controller;
  }

  /** Wire persistence to a controller's change/notice streams. */
  private attach(controller: GameController): void {
    if (!this.persistence.isEnabled) return;
    controller.onChange(() => this.scheduleSave(controller));
    controller.onNotice((m) => {
      if (m.kind === "game_over") void this.flush(controller); // persist final state promptly
    });
  }

  private scheduleSave(controller: GameController): void {
    const id = controller.state.game_id;
    const existing = this.saveTimers.get(id);
    if (existing) clearTimeout(existing);
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id);
        void this.flush(controller);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  private async flush(controller: GameController): Promise<void> {
    try {
      await this.persistence.save(controller.getState());
    } catch {
      // best-effort; don't crash the game on a disk error
    }
  }

  get(id: string): GameController | undefined {
    return this.games.get(id);
  }

  list(): GameController[] {
    return [...this.games.values()];
  }

  async remove(id: string): Promise<boolean> {
    const timer = this.saveTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.saveTimers.delete(id);
    }
    await this.persistence.remove(id);
    return this.games.delete(id);
  }
}
