/**
 * REST API. The controller is authoritative; these endpoints create games,
 * issue control commands, and return mode-appropriate projections. God-only
 * data is NEVER returned from no-vision endpoints.
 */

import {
  MODEL_POOL,
  createGameRequestSchema,
  playerActionSchema,
  type AutoSpeed,
  type SpectatorMode,
} from "@avalon/shared";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import type { GameController } from "../controller/controller.js";
import type { GameStore } from "../storage/store.js";

function modeFromQuery(q: unknown): SpectatorMode {
  const mode = (q as { mode?: string } | undefined)?.mode;
  return mode === "god" ? "god" : "no_vision";
}

function viewFor(controller: GameController, mode: SpectatorMode) {
  return mode === "god" ? controller.getGodView() : controller.getPublicView();
}

function realModeConfigError(server: ServerConfig): string | null {
  if (server.forceMock) return "server is running with FORCE_MOCK=true";
  if (!server.gateway.baseUrl) return "GATEWAY_BASE_URL is required when Mock mode is disabled";
  if (!server.gateway.apiKey) return "GATEWAY_API_KEY is required when Mock mode is disabled";
  return null;
}

export function registerGameRoutes(
  app: FastifyInstance,
  store: GameStore,
  server: ServerConfig,
): void {
  // List available models.
  app.get("/api/models", async () => ({ models: MODEL_POOL }));

  // List saved/in-memory games (newest first) for the history panel.
  app.get("/api/games", async () => {
    const games = store
      .list()
      .map((g) => g.summary())
      .sort((a, b) => b.created_at - a.created_at);
    return { games };
  });

  // Create a game.
  app.post("/api/games", async (req, reply) => {
    const parsed = createGameRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid config", details: parsed.error.issues });
    }
    if (parsed.data.config?.mock === false) {
      const error = realModeConfigError(server);
      if (error) return reply.code(400).send({ error });
    }
    const controller = store.create(parsed.data.config);
    return reply.code(201).send({ game_id: controller.state.game_id });
  });

  // Helper to resolve a game or 404.
  const requireGame = (id: string, reply: import("fastify").FastifyReply): GameController | null => {
    const g = store.get(id);
    if (!g) {
      reply.code(404).send({ error: `game ${id} not found` });
      return null;
    }
    return g;
  };

  // Get state in the requested spectator mode.
  app.get<{ Params: { gameId: string } }>("/api/games/:gameId", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    return viewFor(g, modeFromQuery(req.query));
  });

  app.get<{ Params: { gameId: string } }>("/api/games/:gameId/public-view", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    return g.getPublicView();
  });

  app.get<{ Params: { gameId: string } }>("/api/games/:gameId/god-view", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    return g.getGodView();
  });

  // The human player's OWN identity (role + secret knowledge), so they can play.
  // Returns only the designated human seat's view — never any other seat's — and
  // is deliberately kept out of PublicGameView (which feeds spectators + models).
  app.get<{ Params: { gameId: string } }>("/api/games/:gameId/human-view", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    return { seat: g.state.config.human_seat, private_view: g.humanPrivateView() };
  });

  app.get<{ Params: { gameId: string } }>("/api/games/:gameId/events", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    const mode = modeFromQuery(req.query);
    return mode === "god"
      ? { events: g.state.event_log }
      : { events: g.getPublicView().public_event_log };
  });

  // Control commands.
  app.post<{ Params: { gameId: string } }>("/api/games/:gameId/start", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    g.start();
    return { ok: true, status: g.state.status };
  });

  app.post<{ Params: { gameId: string } }>("/api/games/:gameId/pause", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    g.pause();
    return { ok: true, status: g.state.status };
  });

  app.post<{ Params: { gameId: string } }>("/api/games/:gameId/resume", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    g.resume();
    return { ok: true, status: g.state.status };
  });

  app.post<{ Params: { gameId: string } }>("/api/games/:gameId/step", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    await g.step();
    return { ok: true, status: g.state.status, phase: g.state.phase };
  });

  app.post<{ Params: { gameId: string } }>("/api/games/:gameId/restart", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    await g.restart();
    return { ok: true, status: g.state.status };
  });

  app.post<{ Params: { gameId: string } }>("/api/games/:gameId/postgame-review", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    const res = g.startPostgameReview();
    if (!res.ok) return reply.code(409).send({ error: res.reason ?? "rejected" });
    return { ok: true, postgame_review: g.getPublicView().postgame_review };
  });

  app.post<{ Params: { gameId: string }; Body: { speed?: AutoSpeed } }>(
    "/api/games/:gameId/auto-speed",
    async (req, reply) => {
      const g = requireGame(req.params.gameId, reply);
      if (!g) return;
      const speed = req.body?.speed;
      if (speed === "slow" || speed === "medium" || speed === "fast") {
        g.setAutoSpeed(speed);
        return { ok: true, speed };
      }
      return reply.code(400).send({ error: "speed must be slow|medium|fast" });
    },
  );

  // Submit a human player's action (answer to a pending turn, or grab the floor).
  app.post<{ Params: { gameId: string } }>("/api/games/:gameId/human-action", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    const parsed = playerActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid action", details: parsed.error.issues });
    }
    const res = g.submitHumanAction(parsed.data);
    if (!res.ok) return reply.code(409).send({ error: res.reason ?? "rejected" });
    return { ok: true };
  });

  // Export full replay bundle (contains hidden state — intended for local debug/replay).
  app.post<{ Params: { gameId: string } }>("/api/games/:gameId/export", async (req, reply) => {
    const g = requireGame(req.params.gameId, reply);
    if (!g) return;
    return g.export();
  });

  // Delete a game from memory and disk.
  app.delete<{ Params: { gameId: string } }>("/api/games/:gameId", async (req, reply) => {
    const removed = await store.remove(req.params.gameId);
    if (!removed) return reply.code(404).send({ error: `game ${req.params.gameId} not found` });
    return { ok: true };
  });
}
