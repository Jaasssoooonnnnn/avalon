import { useMemo } from "react";
import {
  roleLabel,
  playerLabel,
  type GodView,
  type RevealedIdentity,
  type PublicGameView,
  type PublicPlayerInfo,
  type PlayerId,
} from "@avalon/shared";
import type { LiveNotice } from "../lib/useGameSocket";
import { PlayerMindPanel } from "./PlayerMindPanel";

interface RoundTableProps {
  pub: PublicGameView;
  god: GodView | null;
  notices: LiveNotice[];
  selectedPlayer?: PlayerId | null;
  onSelectPlayer?: (player: PlayerId) => void;
  onCloseMind?: () => void;
}

const STATUS_MARK: Record<string, string> = {
  leader: "👑",
  speaking: "🗣️",
  interrupt_queue: "💬",
  cooldown: "💤",
  targeted: "❓",
  voting: "🗳️",
  on_mission: "⚔️",
  assassinating: "🗡️",
  idle: "",
};

const STATUS_LABEL: Record<string, string> = {
  idle: "待命",
  leader: "队长",
  speaking: "发言中",
  interrupt_queue: "想插话",
  cooldown: "冷却",
  targeted: "被点名",
  voting: "投票中",
  on_mission: "任务中",
  assassinating: "刺杀中",
};

export function RoundTable({ pub, god, notices, selectedPlayer, onSelectPlayer, onCloseMind }: RoundTableProps) {
  const thinking = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const n of notices) {
      if (n.kind === "model_call_started") map[n.player] = true;
      else if (n.kind === "model_call_completed") map[n.player] = false;
    }
    return map;
  }, [notices]);

  const count = pub.players.length;

  return (
    <div className="table-wrap">
      <div className="round-table">
        <div className="table-center">
          <CenterState pub={pub} />
        </div>
        {pub.players.map((p, i) => {
          const angle = -90 + (360 / count) * i;
          const rad = (angle * Math.PI) / 180;
          const x = 50 + 41 * Math.cos(rad);
          const y = 50 + 39 * Math.sin(rad);
          return (
            <div key={p.id} className="seat-pos" style={{ left: `${x}%`, top: `${y}%` }}>
              <Seat
                info={p}
                god={god}
                revealed={pub.revealed_identities?.[p.id as PlayerId] ?? null}
                thinking={!!thinking[p.id]}
                isHuman={pub.human_seat === p.id}
                selected={selectedPlayer === p.id}
                onSelect={god && onSelectPlayer ? () => onSelectPlayer(p.id as PlayerId) : undefined}
              />
            </div>
          );
        })}
        {god && selectedPlayer && onCloseMind && (
          <PlayerMindPanel
            player={selectedPlayer}
            notes={god.state.players[selectedPlayer].private_view.notes ?? []}
            onClose={onCloseMind}
          />
        )}
      </div>
    </div>
  );
}

function Seat({
  info,
  god,
  revealed,
  thinking,
  isHuman,
  selected,
  onSelect,
}: {
  info: PublicPlayerInfo;
  god: GodView | null;
  revealed: RevealedIdentity | null;
  thinking: boolean;
  isHuman: boolean;
  selected: boolean;
  onSelect?: () => void;
}) {
  const secret = god?.state.players[info.id as PlayerId];
  const visibleIdentity = secret
    ? { role: secret.role, alignment: secret.alignment }
    : revealed;
  const classes = [
    "seat",
    info.is_current_speaker ? "speaking" : "",
    info.is_leader ? "leader" : "",
    info.is_on_proposed_team ? "on-team" : "",
    info.is_targeted ? "targeted" : "",
    info.in_cooldown ? "cooldown" : "",
    thinking ? "thinking" : "",
    isHuman ? "human" : "",
    onSelect ? "selectable" : "",
    selected ? "selected" : "",
    visibleIdentity ? `align-${visibleIdentity.alignment}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (!onSelect) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="seat-head">
        <span className="seat-id">{info.id}</span>
        {isHuman && <span className="badge you" title="你(人类玩家)">🧑</span>}
        {info.is_leader && <span className="badge crown" title="队长">👑</span>}
        {info.has_pending_interrupt && <span className="badge" title="想插话">💬</span>}
        {info.is_targeted && <span className="badge" title="被点名">❓</span>}
        {info.last_vote !== null && (
          <span className={`badge vote ${info.last_vote ? "yes" : "no"}`} title="上次投票">
            {info.last_vote ? "✓" : "✗"}
          </span>
        )}
      </div>
      <div className="seat-model">{isHuman ? "你 (人类玩家)" : info.model}</div>
      <div className="seat-status">
        {thinking ? (
          <span className="dots">思考中…</span>
        ) : (
          <>
            {STATUS_MARK[info.status]} {STATUS_LABEL[info.status] ?? info.status}
          </>
        )}
      </div>
      {visibleIdentity && (
        <div className="seat-secret">
          <span className={`role-badge ${visibleIdentity.alignment}`}>{roleLabel(visibleIdentity.role)}</span>
          {secret?.private_view.known_evil_players && (
            <span className="secret-note">看到邪恶方:{secret.private_view.known_evil_players.join("、")}</span>
          )}
          {secret?.private_view.merlin_candidates && (
            <span className="secret-note">梅林候选:{secret.private_view.merlin_candidates.join(" / ")}</span>
          )}
          {secret?.private_view.evil_team && secret.role !== "Oberon" && (
            <span className="secret-note">
              已知队友:{secret.private_view.evil_team.filter((id) => id !== info.id).join("、") || "无"}
            </span>
          )}
          {secret?.role === "Oberon" && <span className="secret-note">孤狼</span>}
        </div>
      )}
    </div>
  );
}

function CenterState({ pub }: { pub: PublicGameView }) {
  if (pub.status === "completed" && pub.winner) {
    return (
      <div className={`center-result ${pub.winner}`}>
        <div className="winner">{pub.winner === "good" ? "正义方获胜" : "邪恶方获胜"}</div>
        <div className="reason">{pub.game_over_reason}</div>
      </div>
    );
  }
  return (
    <div className="center-info">
      <div className="center-quest">任务 {pub.quest_index + 1}</div>
      {pub.proposed_team && (
        <div className="center-team">
          {pub.proposed_team.map((id) => (
            <span key={id} className="team-chip">{id}</span>
          ))}
        </div>
      )}
      {pub.current_speaker && <div className="center-speaker">{playerLabel(pub.current_speaker)} 发言中</div>}
    </div>
  );
}
