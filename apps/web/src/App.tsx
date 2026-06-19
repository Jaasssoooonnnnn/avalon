import { useCallback, useEffect, useState } from "react";
import type { GameConfig, PlayerId, PrivatePlayerView, SpectatorMode } from "@avalon/shared";
import { api } from "./lib/api";
import { deriveViews, useGameSocket } from "./lib/useGameSocket";
import { Setup } from "./components/Setup";
import { TopBar } from "./components/TopBar";
import { RoundTable } from "./components/RoundTable";
import { QuestProgress } from "./components/QuestProgress";
import { Chat } from "./components/Chat";
import { ControlBar } from "./components/ControlBar";
import { DebugDrawer } from "./components/DebugDrawer";
import { HumanControls } from "./components/HumanControls";
import { Replay } from "./components/Replay";
import { YourIdentity } from "./components/YourIdentity";

export function App() {
  const [gameId, setGameId] = useState<string | null>(null);
  const [mode, setMode] = useState<SpectatorMode>("no_vision");
  const [debugOpen, setDebugOpen] = useState(false);
  const [replay, setReplay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [humanView, setHumanView] = useState<PrivatePlayerView | null>(null);
  const [selectedMindPlayer, setSelectedMindPlayer] = useState<PlayerId | null>(null);

  const { snapshot, connected, notices } = useGameSocket(gameId, mode);
  const { pub, god } = deriveViews(snapshot);

  // The human's own identity comes from a dedicated endpoint (NOT the public
  // view), fetched once the game is known to have a human seat. It is static.
  const humanSeat = pub?.human_seat ?? null;
  useEffect(() => {
    if (!gameId || !humanSeat) {
      setHumanView(null);
      return;
    }
    let cancelled = false;
    api
      .getHumanView(gameId)
      .then((r) => {
        if (!cancelled) setHumanView(r.private_view);
      })
      .catch(() => {
        if (!cancelled) setHumanView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [gameId, humanSeat]);

  useEffect(() => {
    if (mode !== "god" || !god) setSelectedMindPlayer(null);
  }, [mode, god]);

  const handleCreate = useCallback(async (config: Partial<GameConfig>) => {
    setError(null);
    try {
      const { game_id } = await api.createGame(config);
      setGameId(game_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const newGame = useCallback(() => {
    setGameId(null);
    setMode("no_vision");
    setDebugOpen(false);
    setReplay(false);
    setSelectedMindPlayer(null);
  }, []);

  if (!gameId || !pub) {
    return (
      <Setup
        onCreate={handleCreate}
        onLoad={(id) => setGameId(id)}
        error={error}
        connecting={!!gameId && !pub}
      />
    );
  }

  if (replay && snapshot) {
    return (
      <Replay
        snapshot={snapshot}
        mode={mode}
        onToggleMode={() => setMode((m) => (m === "god" ? "no_vision" : "god"))}
        onExit={() => setReplay(false)}
      />
    );
  }

  return (
    <div className="app">
      <TopBar
        pub={pub}
        mode={mode}
        connected={connected}
        onToggleMode={() => setMode((m) => (m === "god" ? "no_vision" : "god"))}
        onNewGame={newGame}
      />

      <div className="main-grid">
        <section className={`left-col ${pub.human_seat && humanView ? "with-identity" : ""}`}>
          {pub.human_seat && humanView && <YourIdentity view={humanView} />}
          <QuestProgress pub={pub} god={god} />
          <RoundTable
            pub={pub}
            god={god}
            notices={notices}
            selectedPlayer={selectedMindPlayer}
            onSelectPlayer={setSelectedMindPlayer}
            onCloseMind={() => setSelectedMindPlayer(null)}
          />
        </section>
        <aside className={`right-col ${pub.human_seat ? "with-human" : ""}`}>
          <Chat pub={pub} />
          {pub.human_seat && (
            <HumanControls gameId={gameId} pub={pub} humanView={humanView} onError={setError} />
          )}
        </aside>
      </div>

      <ControlBar
        gameId={gameId}
        pub={pub}
        mode={mode}
        debugOpen={debugOpen}
        onToggleDebug={() => setDebugOpen((d) => !d)}
        onReplay={() => setReplay(true)}
        onError={setError}
      />

      {error && <div className="error-toast" onClick={() => setError(null)}>{error}</div>}

      {mode === "god" && debugOpen && god && (
        <DebugDrawer god={god} notices={notices} onClose={() => setDebugOpen(false)} />
      )}
    </div>
  );
}
