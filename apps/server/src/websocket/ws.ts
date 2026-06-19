/**
 * WebSocket real-time layer. Each connection picks a spectator mode and receives
 * a fresh mode-appropriate snapshot on every state change, plus lightweight live
 * notices (model calls, rejections, game over). No-vision connections never
 * receive god-only data.
 */

import type {
  GameController,
} from "../controller/controller.js";
import type { SpectatorMode, WsClientMessage, WsServerMessage } from "@avalon/shared";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { GameStore } from "../storage/store.js";

function snapshotMessage(controller: GameController, mode: SpectatorMode): WsServerMessage {
  if (mode === "god") {
    return { kind: "snapshot", mode: "god", view: controller.getGodView() };
  }
  return { kind: "snapshot", mode: "no_vision", view: controller.getPublicView() };
}

export function registerWebSocket(app: FastifyInstance, store: GameStore): void {
  app.get<{ Params: { gameId: string }; Querystring: { mode?: string } }>(
    "/ws/games/:gameId",
    { websocket: true },
    (connection, req) => {
      const socket: WebSocket = connection.socket;
      const controller = store.get(req.params.gameId);

      let mode: SpectatorMode = req.query.mode === "god" ? "god" : "no_vision";

      const send = (msg: WsServerMessage) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      };

      if (!controller) {
        send({ kind: "notice", message: `game ${req.params.gameId} not found` });
        socket.close();
        return;
      }

      // Initial snapshot.
      send(snapshotMessage(controller, mode));

      const offChange = controller.onChange(() => send(snapshotMessage(controller, mode)));
      const offNotice = controller.onNotice((m) => send(m));

      socket.on("message", (raw: Buffer | string) => {
        let parsed: WsClientMessage | null = null;
        try {
          parsed = JSON.parse(raw.toString()) as WsClientMessage;
        } catch {
          return;
        }
        if (!parsed) return;
        if (parsed.kind === "set_mode") {
          mode = parsed.mode === "god" ? "god" : "no_vision";
          send(snapshotMessage(controller, mode));
        }
        // ping is a no-op keepalive.
      });

      socket.on("close", () => {
        offChange();
        offNotice();
      });
    },
  );
}
