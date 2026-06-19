import { playerLabel, type PublicGameView, type SpectatorMode } from "@avalon/shared";

const PHASE_LABEL: Record<string, string> = {
  setup: "准备",
  role_reveal_private: "身份揭示",
  leader_proposal: "队长发车",
  discussion: "讨论",
  normal_speech: "讨论",
  interrupt_collect: "插话收集",
  interrupt_speech: "插话",
  directed_reply: "定向回应",
  team_finalize: "确认中",
  team_vote: "队伍投票",
  vote_reveal: "票面公开",
  mission_action: "执行任务",
  mission_reveal: "任务结果",
  assassination_discuss: "邪恶方议事",
  assassination: "刺杀",
  game_over: "游戏结束",
};

interface TopBarProps {
  pub: PublicGameView;
  mode: SpectatorMode;
  connected: boolean;
  onToggleMode: () => void;
  onNewGame: () => void;
}

export function TopBar({ pub, mode, connected, onToggleMode, onNewGame }: TopBarProps) {
  const proposed = pub.proposed_team?.join("-") ?? "—";
  return (
    <header className="topbar">
      <div className="brand">
        Avalon <span className="accent">AI 竞技场</span>
      </div>
      <div className="status-pills">
        <Pill label="状态" value={statusText(pub)} tone={statusTone(pub)} />
        <Pill label="任务" value={`${pub.quest_index + 1} / 5`} />
        <Pill label="队长" value={playerLabel(pub.leader)} />
        <Pill label="阶段" value={PHASE_LABEL[pub.phase] ?? pub.phase} />
        <Pill label="发言" value={pub.current_speaker ? playerLabel(pub.current_speaker) : "—"} />
        <Pill label="发车" value={proposed} />
        <Pill
          label="否决"
          value={`${pub.consecutive_rejections} / 5`}
          tone={pub.consecutive_rejections >= 3 ? "warn" : undefined}
        />
      </div>
      <div className="topbar-actions">
        <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "已连接" : "已断开"}>
          ●
        </span>
        <button className={`mode-toggle ${mode}`} onClick={onToggleMode} type="button">
          {mode === "god" ? "👁 上帝模式" : "🙈 观众视角"}
        </button>
        <button className="ghost" onClick={onNewGame} type="button">
          新对局
        </button>
      </div>
    </header>
  );
}

function statusText(pub: PublicGameView): string {
  if (pub.status === "completed") {
    return pub.winner ? `${pub.winner === "good" ? "正义方" : "邪恶方"}获胜` : "已结束";
  }
  if (pub.status === "running") return "进行中";
  if (pub.status === "paused") return "已暂停";
  return "未开始";
}

function statusTone(pub: PublicGameView): "good" | "evil" | "warn" | undefined {
  if (pub.status === "completed" && pub.winner) return pub.winner === "good" ? "good" : "evil";
  if (pub.status === "running") return "warn";
  return undefined;
}

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "evil" | "warn";
}) {
  return (
    <div className={`pill ${tone ?? ""}`}>
      <span className="pill-label">{label}</span>
      <span className="pill-value">{value}</span>
    </div>
  );
}
