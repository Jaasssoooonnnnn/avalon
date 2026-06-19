import type {
  AutoSpeed,
  CreateGameResponse,
  ExportBundle,
  GameConfig,
  GameSummary,
  ModelInfo,
  PlayerId,
  PrivatePlayerView,
} from "@avalon/shared";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there is actually a body — otherwise a
  // bodyless POST (start/step/...) trips Fastify's empty-JSON-body guard.
  const hasBody = init?.body != null;
  const res = await fetch(url, {
    ...init,
    headers: hasBody ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  listModels: () => jsonFetch<{ models: ModelInfo[] }>("/api/models"),

  listGames: () => jsonFetch<{ games: GameSummary[] }>("/api/games"),

  deleteGame: (id: string) => jsonFetch(`/api/games/${id}`, { method: "DELETE" }),

  createGame: (config: Partial<GameConfig>) =>
    jsonFetch<CreateGameResponse>("/api/games", {
      method: "POST",
      body: JSON.stringify({ config }),
    }),

  start: (id: string) => jsonFetch(`/api/games/${id}/start`, { method: "POST" }),
  pause: (id: string) => jsonFetch(`/api/games/${id}/pause`, { method: "POST" }),
  resume: (id: string) => jsonFetch(`/api/games/${id}/resume`, { method: "POST" }),
  step: (id: string) => jsonFetch(`/api/games/${id}/step`, { method: "POST" }),
  restart: (id: string) => jsonFetch(`/api/games/${id}/restart`, { method: "POST" }),
  postgameReview: (id: string) =>
    jsonFetch(`/api/games/${id}/postgame-review`, { method: "POST" }),

  setSpeed: (id: string, speed: AutoSpeed) =>
    jsonFetch(`/api/games/${id}/auto-speed`, {
      method: "POST",
      body: JSON.stringify({ speed }),
    }),

  humanAction: (id: string, action: unknown) =>
    jsonFetch(`/api/games/${id}/human-action`, {
      method: "POST",
      body: JSON.stringify(action),
    }),

  // The human player's own identity (role + secret). Not part of the public view.
  getHumanView: (id: string) =>
    jsonFetch<{ seat: PlayerId | null; private_view: PrivatePlayerView | null }>(
      `/api/games/${id}/human-view`,
    ),

  exportGame: (id: string) =>
    jsonFetch<ExportBundle>(`/api/games/${id}/export`, { method: "POST" }),
};
