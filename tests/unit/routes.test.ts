import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../../apps/server/src/config";
import { registerGameRoutes } from "../../apps/server/src/routes/games";
import { GameStore } from "../../apps/server/src/storage/store";

function serverConfig(extra: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    webOrigin: true,
    gateway: { baseUrl: "", apiKey: "" },
    forceMock: false,
    modelTimeoutMs: 1000,
    persist: false,
    dataDir: "/tmp/none",
    reasoningEffort: "medium",
    ...extra,
  };
}

describe("game routes", () => {
  it("allows mock games without gateway credentials", async () => {
    const app = Fastify();
    const cfg = serverConfig();
    registerGameRoutes(app, new GameStore(cfg), cfg);

    const res = await app.inject({
      method: "POST",
      url: "/api/games",
      payload: { config: { mock: true } },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toHaveProperty("game_id");
  });

  it("rejects real games when gateway credentials are missing", async () => {
    const app = Fastify();
    const cfg = serverConfig();
    registerGameRoutes(app, new GameStore(cfg), cfg);

    const res = await app.inject({
      method: "POST",
      url: "/api/games",
      payload: { config: { mock: false } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "GATEWAY_BASE_URL is required when Mock mode is disabled",
    });
  });
});
