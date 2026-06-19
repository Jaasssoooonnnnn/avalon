import { describe, expect, it } from "vitest";
import { defaultConfig, type GameConfig, type GameEvent, type WsServerMessage } from "@avalon/shared";
import { GameController } from "../../apps/server/src/controller/controller";
import type { ServerConfig } from "../../apps/server/src/config";
import { projectReplay, replayTotal } from "../../apps/web/src/lib/replay";

const server: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  webOrigin: true,
  gateway: { baseUrl: "", apiKey: "" },
  forceMock: true,
  modelTimeoutMs: 1000,
  persist: false,
  dataDir: "/tmp/none",
  reasoningEffort: "medium",
};

async function godSnapshot(seed: number): Promise<{ snap: Extract<WsServerMessage, { kind: "snapshot" }>; winner: string | null }> {
  const config: GameConfig = { ...defaultConfig(), mock: true, seed };
  const g = new GameController(`g${seed}`, config, server);
  await g.runToCompletion();
  return {
    snap: { kind: "snapshot", mode: "god", view: g.getGodView() },
    winner: g.state.winner,
  };
}

describe("replay projection", () => {
  it("reconstructs start, middle, and end of a game from the event log", async () => {
    const { snap, winner } = await godSnapshot(9);
    const total = replayTotal(snap);
    expect(total).toBeGreaterThan(0);

    // Start: nothing decided.
    const start = projectReplay(snap, 0);
    expect(start.pub.status).toBe("not_started");
    expect(start.pub.winner).toBeNull();
    expect(start.pub.quest_history.every((q) => q.result === null)).toBe(true);

    // End: matches the final outcome.
    const end = projectReplay(snap, total);
    expect(end.pub.status).toBe("completed");
    expect(end.pub.winner).toBe(winner);
    expect(end.pub.public_event_log.length).toBe(total);

    // Monotonic: a midpoint has no more resolved quests than the end.
    const mid = projectReplay(snap, Math.floor(total / 2));
    const resolved = (f: typeof mid) => f.pub.quest_history.filter((q) => q.result !== null).length;
    expect(resolved(mid)).toBeLessThanOrEqual(resolved(end));
    expect(mid.pub.public_event_log.length).toBe(Math.floor(total / 2));
  });

  it("keeps god roles available while gating mission cards to the current frame", async () => {
    const { snap } = await godSnapshot(2);
    const total = replayTotal(snap);
    const start = projectReplay(snap, 0);
    const end = projectReplay(snap, total);
    // Roles are static and present throughout.
    expect(Object.values(start.god!.state.players).every((p) => !!p.role)).toBe(true);
    // The full-log slice grows as we advance (mission cards revealed over time).
    expect(end.god!.state.event_log.length).toBeGreaterThan(start.god!.state.event_log.length);
  });

  it("rebuilds private memo notes only up to the current replay frame", () => {
    const config: GameConfig = { ...defaultConfig(), mock: true, seed: 5 };
    const g = new GameController("memo_replay", config, server);
    const base = g.state.event_log;
    const now = Date.now();
    const extra: GameEvent[] = [
      {
        type: "private_memo",
        player: "A",
        memo: "第一条内心戏",
        visibility: "god_only",
        event_id: "evt_memo_1",
        timestamp: now + 1,
      },
      {
        type: "public_speech",
        player: "A",
        target: null,
        speech: "公开第一句",
        source: "normal",
        event_id: "evt_speech_1",
        timestamp: now + 2,
      },
      {
        type: "private_memo",
        player: "A",
        memo: "第二条内心戏",
        visibility: "god_only",
        event_id: "evt_memo_2",
        timestamp: now + 3,
      },
      {
        type: "public_speech",
        player: "A",
        target: null,
        speech: "公开第二句",
        source: "normal",
        event_id: "evt_speech_2",
        timestamp: now + 4,
      },
    ];
    g.state.event_log = [...base, ...extra];
    g.state.players.A.private_view.notes = ["第一条内心戏", "第二条内心戏"];
    const snap: Extract<WsServerMessage, { kind: "snapshot" }> = {
      kind: "snapshot",
      mode: "god",
      view: g.getGodView(),
    };

    const beforeSpeech = projectReplay(snap, 2);
    expect(beforeSpeech.god!.state.players.A.private_view.notes).toEqual([]);

    const afterFirstSpeech = projectReplay(snap, 3);
    expect(afterFirstSpeech.god!.state.players.A.private_view.notes).toEqual(["第一条内心戏"]);

    const afterSecondSpeech = projectReplay(snap, 4);
    expect(afterSecondSpeech.god!.state.players.A.private_view.notes).toEqual(["第一条内心戏", "第二条内心戏"]);
  });
});
