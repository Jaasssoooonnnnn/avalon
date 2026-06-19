import { useEffect, useMemo, useState } from "react";
import type { PlayerId, SpectatorMode } from "@avalon/shared";
import type { Snapshot } from "../lib/useGameSocket";
import { projectReplay, replayTotal } from "../lib/replay";
import { RoundTable } from "./RoundTable";
import { QuestProgress } from "./QuestProgress";
import { Chat } from "./Chat";

interface ReplayProps {
  snapshot: Snapshot;
  mode: SpectatorMode;
  onToggleMode: () => void;
  onExit: () => void;
}

const SPEEDS: { label: string; ms: number }[] = [
  { label: "慢", ms: 1600 },
  { label: "中", ms: 800 },
  { label: "快", ms: 300 },
];

export function Replay({ snapshot, mode, onToggleMode, onExit }: ReplayProps) {
  const total = useMemo(() => replayTotal(snapshot), [snapshot]);
  const [idx, setIdx] = useState(total);
  const [playing, setPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState(800);
  const [selectedMindPlayer, setSelectedMindPlayer] = useState<PlayerId | null>(null);

  // Keep idx in range if the underlying snapshot grows/shrinks.
  useEffect(() => {
    setIdx((i) => Math.min(i, total));
  }, [total]);

  useEffect(() => {
    if (!playing) return;
    if (idx >= total) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIdx((i) => Math.min(i + 1, total)), speedMs);
    return () => clearTimeout(t);
  }, [playing, idx, total, speedMs]);

  const frame = useMemo(() => projectReplay(snapshot, idx), [snapshot, idx]);
  const pub = frame.pub;

  useEffect(() => {
    if (mode !== "god" || !frame.god) setSelectedMindPlayer(null);
  }, [mode, frame.god]);

  const jump = (n: number) => {
    setPlaying(false);
    setIdx(Math.max(0, Math.min(n, total)));
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          复盘 <span className="accent">Replay</span>
        </div>
        <div className="status-pills">
          <Pill label="进度" value={`${idx} / ${total}`} />
          <Pill label="任务" value={`${pub.quest_index + 1} / 5`} />
          <Pill label="队长" value={`玩家${pub.leader}`} />
          <Pill
            label="结果"
            value={pub.winner ? (pub.winner === "good" ? "正义方胜" : "邪恶方胜") : "进行中"}
          />
        </div>
        <div className="topbar-actions">
          <button className={`mode-toggle ${mode}`} onClick={onToggleMode} type="button">
            {mode === "god" ? "👁 上帝模式" : "🙈 观众视角"}
          </button>
          <button className="ghost" onClick={onExit} type="button">
            退出复盘
          </button>
        </div>
      </header>

      <div className="main-grid">
        <section className="left-col">
          <QuestProgress pub={pub} god={frame.god} />
          <RoundTable
            pub={pub}
            god={frame.god}
            notices={[]}
            selectedPlayer={selectedMindPlayer}
            onSelectPlayer={setSelectedMindPlayer}
            onCloseMind={() => setSelectedMindPlayer(null)}
          />
        </section>
        <aside className="right-col">
          <Chat pub={pub} />
        </aside>
      </div>

      <footer className="controlbar replay-bar">
        <div className="cb-group">
          <button onClick={() => jump(0)} type="button" title="回到开头">⏮</button>
          <button onClick={() => jump(idx - 1)} disabled={idx <= 0} type="button">◀</button>
          <button
            className="primary"
            onClick={() => setPlaying((p) => !p)}
            disabled={idx >= total}
            type="button"
          >
            {playing ? "⏸ 暂停" : "▶ 播放"}
          </button>
          <button onClick={() => jump(idx + 1)} disabled={idx >= total} type="button">▶</button>
          <button onClick={() => jump(total)} type="button" title="跳到结尾">⏭</button>
        </div>

        <input
          className="replay-slider"
          type="range"
          min={0}
          max={total}
          value={idx}
          onChange={(e) => jump(Number(e.target.value))}
        />

        <div className="cb-group">
          <span className="cb-label">速度</span>
          {SPEEDS.map((s) => (
            <button
              key={s.label}
              className={speedMs === s.ms ? "active" : ""}
              onClick={() => setSpeedMs(s.ms)}
              type="button"
            >
              {s.label}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="pill">
      <span className="pill-label">{label}</span>
      <span className="pill-value">{value}</span>
    </div>
  );
}
