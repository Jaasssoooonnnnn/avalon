import { describe, expect, it } from "vitest";
import { SEAT_ORDER, defaultConfig, type GameState, type PlayerId } from "@avalon/shared";
import { createInitialState } from "../../apps/server/src/game/state";
import { toGodView, toPublicGameView } from "../../apps/server/src/game/views";
import { IdGen } from "../../apps/server/src/utils/ids";
import { makeRng } from "../../apps/server/src/utils/random";

function freshState(seed: number): GameState {
  const config = { ...defaultConfig(), seed };
  return createInitialState("t", config, new IdGen(), makeRng(seed));
}

function findByRole(s: GameState, role: string): PlayerId {
  return (Object.values(s.players).find((p) => p.role === role)!).id;
}

function hasThreeConsecutiveEvilSeats(s: GameState): boolean {
  const evilIndexes = new Set(
    SEAT_ORDER.map((id, index) => (s.players[id].alignment === "evil" ? index : -1)).filter(
      (index) => index >= 0,
    ),
  );

  for (let i = 0; i < SEAT_ORDER.length; i++) {
    if (
      evilIndexes.has(i) &&
      evilIndexes.has((i + 1) % SEAT_ORDER.length) &&
      evilIndexes.has((i + 2) % SEAT_ORDER.length)
    ) {
      return true;
    }
  }
  return false;
}

describe("role dealing", () => {
  it("deals exactly the 4-good / 3-evil bag", () => {
    const s = freshState(7);
    const roles = Object.values(s.players)
      .map((p) => p.role)
      .sort();
    expect(roles).toEqual(
      ["Assassin", "Loyal Servant", "Loyal Servant", "Merlin", "Morgana", "Oberon", "Percival"].sort(),
    );
    const evil = Object.values(s.players).filter((p) => p.alignment === "evil");
    expect(evil).toHaveLength(3);
  });

  it("re-deals when all three evil players would sit consecutively", () => {
    // Before the no-three-consecutive guard, seed 10 dealt D-E-F as evil.
    const s = freshState(10);
    expect(hasThreeConsecutiveEvilSeats(s)).toBe(false);
  });

  it("never deals all three evil players into a consecutive circular run", () => {
    for (let seed = 1; seed <= 250; seed++) {
      expect(hasThreeConsecutiveEvilSeats(freshState(seed))).toBe(false);
    }
  });
});

describe("private views (identity-information rules)", () => {
  const s = freshState(123);
  const merlin = findByRole(s, "Merlin");
  const percival = findByRole(s, "Percival");
  const morgana = findByRole(s, "Morgana");
  const assassin = findByRole(s, "Assassin");
  const oberon = findByRole(s, "Oberon");
  const servant = (Object.values(s.players).find((p) => p.role === "Loyal Servant")!).id;
  const evilSet = new Set(
    Object.values(s.players).filter((p) => p.alignment === "evil").map((p) => p.id),
  );
  const visibleEvilSet = new Set([assassin, morgana]);

  it("Merlin sees all three evil players (and only those)", () => {
    const known = new Set(s.players[merlin].private_view.known_evil_players);
    expect(known).toEqual(evilSet);
    expect(known.size).toBe(3);
  });

  it("Percival sees Merlin + Morgana as the two candidates", () => {
    const cands = s.players[percival].private_view.merlin_candidates!;
    expect(new Set(cands)).toEqual(new Set([merlin, morgana]));
    expect(cands).toHaveLength(2);
  });

  it("Assassin and Morgana see each other but not Oberon", () => {
    expect(new Set(s.players[assassin].private_view.evil_team)).toEqual(visibleEvilSet);
    expect(new Set(s.players[morgana].private_view.evil_team)).toEqual(visibleEvilSet);
  });

  it("Oberon is isolated from the evil team", () => {
    expect(s.players[oberon].private_view.evil_team).toEqual([oberon]);
    expect(s.players[assassin].private_view.evil_team).not.toContain(oberon);
    expect(s.players[morgana].private_view.evil_team).not.toContain(oberon);
  });

  it("Loyal Servant has no hidden info", () => {
    const v = s.players[servant].private_view;
    expect(v.known_evil_players).toBeUndefined();
    expect(v.merlin_candidates).toBeUndefined();
    expect(v.evil_team).toBeUndefined();
  });
});

describe("public vs god projection boundary", () => {
  const s = freshState(99);

  it("public players carry NO role/alignment/private data", () => {
    const pub = toPublicGameView(s);
    for (const p of pub.players) {
      expect(p).not.toHaveProperty("role");
      expect(p).not.toHaveProperty("alignment");
      expect(p).not.toHaveProperty("private_view");
    }
  });

  it("public event log hides god-only events (role_assigned)", () => {
    const pub = toPublicGameView(s);
    const types = new Set(pub.public_event_log.map((e) => e.type));
    expect(types.has("role_assigned" as never)).toBe(false);
  });

  it("god view exposes full state with roles", () => {
    const god = toGodView(s);
    expect(Object.values(god.state.players).every((p) => !!p.role)).toBe(true);
    expect(god.public_view.players.length).toBe(7);
  });
});

describe("human-mode public view stays clean", () => {
  it("never folds the human's private view / role into PublicGameView", () => {
    const config = { ...defaultConfig(), seed: 7, human_seat: "A" as PlayerId };
    const s2 = createInitialState("h", config, new IdGen(), makeRng(7));
    const pub = toPublicGameView(s2);

    // The leak vector: human_private_view must not exist on the public view.
    expect(pub).not.toHaveProperty("human_private_view");
    // human_seat itself is public-safe coordination info.
    expect(pub.human_seat).toBe("A");

    // The serialized public view (what spectators AND model adapters receive)
    // must contain no private-view markers nor any player's role enum value.
    const json = JSON.stringify(pub);
    expect(json).not.toContain("private_view");
    expect(json).not.toContain("notes");
    expect(json).not.toContain("strategic_reminder");
    expect(json).not.toContain("known_evil_players");
    for (const id of s2.seat_order) {
      expect(json).not.toContain(s2.players[id].role);
    }
  });
});
