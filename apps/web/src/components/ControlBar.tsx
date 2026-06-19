import { useState } from "react";
import {
  alignmentLabel,
  playerLabel,
  roleLabel,
  type GamePhase,
  type PublicGameView,
  type SpectatorMode,
} from "@avalon/shared";
import { api } from "../lib/api";

interface ControlBarProps {
  gameId: string;
  pub: PublicGameView;
  mode: SpectatorMode;
  debugOpen: boolean;
  onToggleDebug: () => void;
  onReplay: () => void;
  onError: (msg: string) => void;
}

/** Group discussion sub-phases together for the "Next Phase" jump. */
const PHASE_GROUP: Record<string, string> = {
  discussion: "discussion",
  normal_speech: "discussion",
  interrupt_collect: "discussion",
  interrupt_speech: "discussion",
  directed_reply: "discussion",
};
const group = (p: GamePhase) => PHASE_GROUP[p] ?? p;

export function ControlBar({ gameId, pub, mode, debugOpen, onToggleDebug, onReplay, onError }: ControlBarProps) {
  const [busy, setBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);

  const running = pub.status === "running";
  const completed = pub.status === "completed";
  const canStartPostgame =
    completed &&
    (pub.postgame_review.status === "not_started" ||
      pub.postgame_review.status === "running" ||
      pub.postgame_review.status === "waiting_human");

  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const onRunPause = () =>
    guard(() => (running ? api.pause(gameId) : api.start(gameId)));

  const onStep = () => guard(() => api.step(gameId));

  const onNextPhase = async () => {
    setBusy(true);
    try {
      const start = group(pub.phase);
      for (let i = 0; i < 50; i++) {
        const r = (await api.step(gameId)) as { phase: GamePhase; status: string };
        if (r.status === "completed") break;
        if (group(r.phase) !== start) break;
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRestart = () => guard(() => api.restart(gameId));

  const onPostgameReview = async () => {
    setReviewBusy(true);
    try {
      await api.postgameReview(gameId);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  };

  const onCopyLog = async () => {
    const text = pub.public_event_log
      .filter((e) => e.type === "public_speech" || e.type === "speech_passed" || e.type === "team_proposed" || e.type === "vote_revealed" || e.type === "mission_result" || e.type === "game_over" || e.type === "postgame_roles_revealed")
      .map((e) =>
        e.type === "public_speech"
          ? `${playerLabel(e.player)}${e.source === "postgame_review" ? "(赛后复盘)" : ""}:${e.speech}`
          : e.type === "speech_passed"
            ? `${playerLabel(e.player)}:(过)`
            : e.type === "postgame_roles_revealed"
              ? `赛后身份公开:${Object.entries(e.identities)
                  .map(([id, info]) => `${id}:${roleLabel(info.role)}(${alignmentLabel(info.alignment)})`)
                  .join("；")}`
            : `[${e.type}]`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      onError("无法访问剪贴板");
    }
  };

  return (
    <footer className="controlbar">
      <div className="cb-group">
        <button className="primary" onClick={onRunPause} disabled={completed} type="button">
          {running ? "⏸ 暂停" : pub.status === "not_started" ? "▶ 开始" : "▶ 运行"}
        </button>
        <button onClick={onStep} disabled={completed || busy} type="button">
          ⏭ 单步
        </button>
        <button onClick={onNextPhase} disabled={completed || busy} type="button">
          ⏩ 下一阶段
        </button>
      </div>

      <div className="cb-group right">
        <button onClick={onReplay} type="button">🎞 时间线复盘</button>
        {completed && (
          <button
            className={pub.postgame_review.status !== "not_started" ? "active" : ""}
            onClick={onPostgameReview}
            disabled={!canStartPostgame || reviewBusy}
            type="button"
          >
            🧾 {pub.postgame_review.status === "completed" ? "赛后已复盘" : "赛后复盘"}
          </button>
        )}
        <button onClick={onRestart} type="button">↺ 重开</button>
        <button onClick={onCopyLog} type="button">⧉ 复制日志</button>
        {mode === "god" && (
          <button className={debugOpen ? "active" : ""} onClick={onToggleDebug} type="button">
            🔧 调试
          </button>
        )}
      </div>
    </footer>
  );
}
