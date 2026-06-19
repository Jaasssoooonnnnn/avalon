import { afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type GameConfig } from "@avalon/shared";
import { GameController } from "../../apps/server/src/controller/controller";
import { GamePersistence } from "../../apps/server/src/storage/persistence";
import type { ServerConfig } from "../../apps/server/src/config";

const dir = join(tmpdir(), `avalon-persist-test-${process.pid}`);
const server: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  webOrigin: true,
  gateway: { baseUrl: "", apiKey: "" },
  forceMock: true,
  modelTimeoutMs: 1000,
  persist: true,
  dataDir: dir,
  reasoningEffort: "medium",
};

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("game persistence", () => {
  it("saves a finished game and reloads it for review", async () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 9 };
    const g = new GameController("g_persist_1", config, server);
    await g.runToCompletion();
    expect(g.state.status).toBe("completed");

    const persistence = new GamePersistence(dir, true);
    await persistence.save(g.getState());

    const loaded = await persistence.loadAll();
    expect(loaded).toHaveLength(1);
    const state = loaded[0]!;
    expect(state.game_id).toBe("g_persist_1");
    expect(state.winner).toBe(g.state.winner);
    expect(state.event_log.length).toBe(g.state.event_log.length);

    // Restored controller is viewable and still respects the hidden-info boundary.
    const restored = GameController.restore(state, server);
    expect(restored.getState().winner).toBe(g.state.winner);
    const pub = restored.getPublicView();
    for (const p of pub.players) expect(p).not.toHaveProperty("role");
    expect(Object.values(restored.getGodView().state.players).every((p) => !!p.role)).toBe(true);
  });

  it("does nothing when persistence is disabled", async () => {
    const off = new GamePersistence(join(dir, "disabled"), false);
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 1 };
    const g = new GameController("g_off", config, server);
    await g.runToCompletion();
    await off.save(g.getState());
    expect(await off.loadAll()).toHaveLength(0);
  });

  it("drops pending human prompts on restore because their resolver is in-memory", () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 3, human_seat: "A" };
    const g = new GameController("g_pending_human", config, server);
    g.state.status = "running";
    g.state.phase = "discussion";
    g.state.round.current_speaker = "A";
    g.state.pending_human = {
      player: "A",
      prompt_type: "full_speech",
      legal_actions: ["speak"],
    };

    const restored = GameController.restore(g.getState(), server);

    expect(restored.state.status).toBe("paused");
    expect(restored.state.pending_human).toBeNull();
  });
});
