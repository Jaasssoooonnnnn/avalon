import { useMemo, useState } from "react";
import { playerLabel, type GameEvent, type GodView, type PublicGameView } from "@avalon/shared";

interface QuestProgressProps {
  pub: PublicGameView;
  god: GodView | null;
}

/** Reconstruct per-quest individual mission cards from the god event log. */
function cardsByQuest(events: GameEvent[]): Record<number, { player: string; card: string }[]> {
  const out: Record<number, { player: string; card: string }[]> = {};
  let pending: { player: string; card: string }[] = [];
  for (const e of events) {
    if (e.type === "mission_card_submitted") pending.push({ player: e.player, card: e.card });
    else if (e.type === "mission_result") {
      out[e.quest_index] = pending;
      pending = [];
    }
  }
  return out;
}

export function QuestProgress({ pub, god }: QuestProgressProps) {
  const [open, setOpen] = useState<number | null>(null);
  const cards = useMemo(
    () => (god ? cardsByQuest(god.state.event_log) : {}),
    [god],
  );

  return (
    <div className="quest-progress">
      <div className="quest-nodes">
        {pub.quest_history.map((q) => {
          const active = q.index === pub.quest_index && pub.status !== "completed";
          const cls = [
            "quest-node",
            q.result ? q.result : "pending",
            active ? "active" : "",
            open === q.index ? "open" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={q.index}
              className={cls}
              type="button"
              onClick={() => setOpen(open === q.index ? null : q.index)}
            >
              <div className="quest-num">Q{q.index + 1}</div>
              <div className="quest-meta">
                <span>{q.required_players}人</span>
                <span className="fail-req">{q.fail_cards_required} 失败牌</span>
              </div>
              <div className="quest-result">
                {q.result === "success" ? "✓" : q.result === "fail" ? "✗" : active ? "•" : "—"}
              </div>
            </button>
          );
        })}
      </div>

      {open !== null && (
        <QuestDetail
          q={pub.quest_history[open]!}
          cards={god ? cards[open] : undefined}
        />
      )}
    </div>
  );
}

function QuestDetail({
  q,
  cards,
}: {
  q: PublicGameView["quest_history"][number];
  cards?: { player: string; card: string }[];
}) {
  return (
    <div className="quest-detail">
      <div className="qd-row">
        <span>任务 {q.index + 1}</span>
        <span>{q.required_players} 人 · {q.fail_cards_required} 张失败牌即失败</span>
      </div>
      <div className="qd-row">
        <span>队长</span>
        <span>{q.leader ? playerLabel(q.leader) : "—"}</span>
      </div>
      <div className="qd-row">
        <span>队伍</span>
        <span>{q.team ? q.team.join("、") : "—"}</span>
      </div>
      <div className="qd-row">
        <span>结果</span>
        <span className={q.result ?? ""}>
          {q.result
            ? `${q.result === "success" ? "成功" : "失败"}(${q.fail_count ?? 0} 张失败牌)`
            : "未进行"}
        </span>
      </div>
      {cards && cards.length > 0 && (
        <div className="qd-cards">
          <div className="qd-cards-title">任务牌(上帝模式)</div>
          <div className="qd-cards-list">
            {cards.map((c, i) => (
              <span key={i} className={`mc ${c.card}`}>
                {c.player}:{c.card === "fail" ? "✗" : "✓"}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
