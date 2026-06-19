import { useEffect, useRef, useState } from "react";
import type {
  GodView,
  PublicGameView,
  SpectatorMode,
  WsServerMessage,
} from "@avalon/shared";

type Snapshot = Extract<WsServerMessage, { kind: "snapshot" }>;
export type { Snapshot };
export type LiveNotice = Exclude<WsServerMessage, { kind: "snapshot" }>;

export interface GameSocketState {
  snapshot: Snapshot | null;
  connected: boolean;
  notices: LiveNotice[];
}

/**
 * Connects to /ws/games/:id and tracks the latest mode-appropriate snapshot plus
 * live notices (model calls, rejections, game over). Switching mode sends
 * set_mode without reconnecting; the next snapshot arrives in the new shape.
 */
export function useGameSocket(
  gameId: string | null,
  desiredMode: SpectatorMode,
): GameSocketState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [notices, setNotices] = useState<LiveNotice[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const modeRef = useRef<SpectatorMode>(desiredMode);

  useEffect(() => {
    if (!gameId) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${proto}://${location.host}/ws/games/${gameId}?mode=${modeRef.current}`,
      );
      socketRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(e.data as string) as WsServerMessage;
        } catch {
          return;
        }
        if (msg.kind === "snapshot") setSnapshot(msg);
        else setNotices((n) => [...n.slice(-79), msg]);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [gameId]);

  useEffect(() => {
    modeRef.current = desiredMode;
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ kind: "set_mode", mode: desiredMode }));
    }
  }, [desiredMode]);

  return { snapshot, connected, notices };
}

/** Normalize a snapshot into a public view (+ god view when available). */
export function deriveViews(snapshot: Snapshot | null): {
  pub: PublicGameView | null;
  god: GodView | null;
} {
  if (!snapshot) return { pub: null, god: null };
  if (snapshot.mode === "god") {
    return { pub: snapshot.view.public_view, god: snapshot.view };
  }
  return { pub: snapshot.view, god: null };
}
