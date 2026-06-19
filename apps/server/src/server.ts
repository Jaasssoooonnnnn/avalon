/**
 * Fastify server bootstrap: CORS, WebSocket, REST routes, in-memory store.
 */

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { config } from "./config.js";
import { registerGameRoutes } from "./routes/games.js";
import { GameStore } from "./storage/store.js";
import { registerWebSocket } from "./websocket/ws.js";

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

  // Control endpoints (start/pause/step/...) POST with no body. Treat an empty
  // application/json body as {} instead of rejecting it (FST_ERR_CTP_EMPTY_JSON_BODY).
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (text === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  await app.register(cors, { origin: config.webOrigin });
  await app.register(websocket);

  const store = new GameStore(config);
  await store.init();

  app.get("/health", async () => ({
    ok: true,
    force_mock: config.forceMock,
    gateway_configured: Boolean(config.gateway.baseUrl && config.gateway.apiKey),
    persist: config.persist,
    data_dir: config.dataDir,
  }));

  registerGameRoutes(app, store, config);
  registerWebSocket(app, store);

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    `Avalon AI Arena server listening on http://${config.host}:${config.port} ` +
      `(force_mock=${config.forceMock})`,
  );
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
