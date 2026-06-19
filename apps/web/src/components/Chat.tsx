import { useEffect, useMemo, useRef, useState } from "react";
import {
  SEAT_ORDER,
  alignmentLabel,
  playerLabel,
  roleLabel,
  type PublicEvent,
  type PublicGameView,
  type PlayerId,
} from "@avalon/shared";

type Filter = "all" | "speeches" | "system" | "votes";

interface ChatProps {
  pub: PublicGameView;
}

const SOURCE_TAG: Record<string, string> = {
  interrupt: "插话",
  directed_reply: "回应",
  leader_final: "队长",
  postgame_review: "复盘",
  normal: "",
};

const FILTER_LABEL: Record<Filter, string> = {
  all: "全部",
  speeches: "发言",
  system: "系统",
  votes: "投票",
};

export function Chat({ pub }: ChatProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [player, setPlayer] = useState<PlayerId | "all">("all");
  const listRef = useRef<HTMLDivElement>(null);

  const modelOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of pub.players) m[p.id] = p.model;
    return m;
  }, [pub.players]);

  const items = useMemo(
    () => pub.public_event_log.filter((e) => matches(e, filter, player)),
    [pub.public_event_log, filter, player],
  );

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div className="chat">
      <div className="chat-header">
        <span className="chat-title">公开聊天</span>
        <div className="chat-filters">
          {(["all", "speeches", "system", "votes"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)} type="button">
              {FILTER_LABEL[f]}
            </button>
          ))}
          <select value={player} onChange={(e) => setPlayer(e.target.value as PlayerId | "all")}>
            <option value="all">所有人</option>
            {SEAT_ORDER.map((id) => (
              <option key={id} value={id}>
                {playerLabel(id)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="chat-list" ref={listRef}>
        {items.length === 0 && <div className="chat-empty">还没有消息。</div>}
        {items.map((e, i) => (
          <ChatRow key={i} e={e} modelOf={modelOf} humanSeat={pub.human_seat} />
        ))}
      </div>
    </div>
  );
}

function matches(e: PublicEvent, filter: Filter, player: PlayerId | "all"): boolean {
  if (player !== "all") {
    return (
      (e.type === "public_speech" || e.type === "speech_passed") &&
      e.player === player
    );
  }
  switch (filter) {
    case "all":
      return e.type !== "phase_changed" && e.type !== "game_created" && e.type !== "interrupt_granted";
    case "speeches":
      return e.type === "public_speech";
    case "system":
      return e.type !== "public_speech" && e.type !== "phase_changed" && e.type !== "game_created";
    case "votes":
      return (
        e.type === "vote_revealed" ||
        e.type === "mission_result" ||
        e.type === "team_proposed" ||
        e.type === "assassination_attempt" ||
        e.type === "game_over" ||
        e.type === "postgame_roles_revealed"
      );
    default:
      return true;
  }
}

function ChatRow({
  e,
  modelOf,
  humanSeat,
}: {
  e: PublicEvent;
  modelOf: Record<string, string>;
  humanSeat: PlayerId | null;
}) {
  if (e.type === "public_speech") {
    const tag = SOURCE_TAG[e.source] ?? "";
    const who = e.player === humanSeat ? "你 (人类)" : modelOf[e.player];
    return (
      <div className={`msg speech src-${e.source}`}>
        <div className="msg-head">
          <span className="msg-author">{playerLabel(e.player)}</span>
          <span className="msg-model">{who}</span>
          {tag && <span className="msg-tag">{tag}</span>}
          {e.target && <span className="msg-target">→ {e.target}</span>}
        </div>
        <div className="msg-body">{e.speech}</div>
      </div>
    );
  }
  return (
    <div className="msg system">
      <span className="sys-dot">●</span>
      <span className="sys-text">{systemText(e)}</span>
    </div>
  );
}

function systemText(e: PublicEvent): string {
  switch (e.type) {
    case "team_proposed":
      return `${playerLabel(e.leader)} 发车:${e.team.join("、")}。`;
    case "vote_revealed":
      return `投票${e.passed ? "通过" : "否决"}(赞成 ${e.approvals.length} – 反对 ${e.rejections.length})。` +
        `赞成:${e.approvals.join(",") || "无"} · 反对:${e.rejections.join(",") || "无"}。`;
    case "mission_result":
      return `任务 ${e.quest_index + 1} ${e.passed ? "成功" : "失败"} — ${e.fail_count} 张失败牌。`;
    case "leader_changed":
      return `${playerLabel(e.leader)} 成为新队长。`;
    case "speech_passed":
      return `${playerLabel(e.player)} 选择跳过本轮发言。`;
    case "assassination_attempt":
      return `刺客(${playerLabel(e.assassin)})指认了 ${playerLabel(e.target)}……`;
    case "game_over":
      return `游戏结束——${e.winner === "good" ? "正义方" : "邪恶方"}获胜。${e.reason}`;
    case "postgame_roles_revealed":
      return `赛后复盘开始,所有身份公开: ${Object.entries(e.identities)
        .map(([id, info]) => `${playerLabel(id as PlayerId)}:${roleLabel(info.role)}(${alignmentLabel(info.alignment)})`)
        .join("；")}。`;
    default:
      return e.type;
  }
}
