import { useState } from "react";
import { SEAT_ORDER, playerLabel, roleLabel, type GodView, type PlayerId } from "@avalon/shared";
import type { LiveNotice } from "../lib/useGameSocket";

type Tab = "models" | "interrupts" | "state" | "views" | "events";

const TAB_LABEL: Record<Tab, string> = {
  models: "模型",
  interrupts: "插话",
  state: "状态",
  views: "视图",
  events: "事件",
};

interface DebugDrawerProps {
  god: GodView;
  notices: LiveNotice[];
  onClose: () => void;
}

export function DebugDrawer({ god, notices, onClose }: DebugDrawerProps) {
  const [tab, setTab] = useState<Tab>("models");
  const [viewPlayer, setViewPlayer] = useState<PlayerId>("A");
  const s = god.state;

  return (
    <div className="debug-drawer">
      <div className="dd-head">
        <strong>上帝模式 · 调试</strong>
        <div className="dd-tabs">
          {(["models", "interrupts", "state", "views", "events"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} type="button">
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <button className="dd-close" onClick={onClose} type="button">✕</button>
      </div>

      <div className="dd-body">
        {tab === "models" && (
          <div className="dd-models">
            <table className="dd-table">
              <thead>
                <tr>
                  <th>座位</th><th>模型</th><th>请求</th><th>通过</th><th>毫秒</th><th>Token(进/出/读/写)</th><th>原始 / 拒绝原因</th>
                </tr>
              </thead>
              <tbody>
                {[...s.last_model_calls].reverse().map((c, i) => (
                  <tr key={i} className={c.accepted ? "" : "rejected"}>
                    <td>{c.player}</td>
                    <td>{c.model}</td>
                    <td>{c.prompt_type}</td>
                    <td>{c.accepted ? "✓" : "✗"}</td>
                    <td>{c.latency_ms}</td>
                    <td>{c.usage ? usageText(c.usage) : "—"}</td>
                    <td className="raw">{c.accepted ? truncate(c.raw_text, 120) : c.reject_reason}</td>
                  </tr>
                ))}
                {s.last_model_calls.length === 0 && (
                  <tr><td colSpan={7} className="muted">暂无模型调用。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === "interrupts" && (
          <div className="dd-interrupts">
            <div className="dd-sub">
              本阶段插话预算剩余:<b>{s.interrupts.phase_budget_remaining}</b> ·
              {" "}到达计数:{s.interrupts.arrival_counter}
            </div>
            <div className="dd-sub">
              定向对话:{" "}
              {s.interrupts.directed_dialogue
                ? `${playerLabel(s.interrupts.directed_dialogue.initiator)} → ${playerLabel(s.interrupts.directed_dialogue.target)}(第 ${s.interrupts.directed_dialogue.exchanges} 次${s.interrupts.directed_dialogue.merged_with_normal ? ",合并正常发言" : ""})`
                : "无"}
            </div>
            <h4>队列 + 优先级分数</h4>
            <table className="dd-table">
              <thead><tr><th>请求</th><th>玩家</th><th>目标</th><th>到达</th><th>分数</th><th>内容</th></tr></thead>
              <tbody>
                {s.interrupts.queue.map((r) => (
                  <tr key={r.request_id}>
                    <td>{r.request_id}</td><td>{r.player}</td><td>{r.target ?? "—"}</td>
                    <td>{r.arrival_seq}</td><td>{god.interrupt_scores[r.request_id] ?? r.score}</td>
                    <td className="raw">{truncate(r.speech, 80)}</td>
                  </tr>
                ))}
                {s.interrupts.queue.length === 0 && <tr><td colSpan={6} className="muted">队列为空。</td></tr>}
              </tbody>
            </table>
            <h4>发言统计 / 冷却</h4>
            <table className="dd-table">
              <thead><tr><th>座位</th><th>本阶段正常</th><th>本阶段插话</th><th>本轮插话</th><th>累计</th><th>冷却至</th></tr></thead>
              <tbody>
                {SEAT_ORDER.map((id) => {
                  const t = s.talk_stats[id];
                  return (
                    <tr key={id}>
                      <td>{id}</td><td>{t.normal_speeches_in_phase}</td><td>{t.interrupts_in_phase}</td>
                      <td>{t.interrupts_in_round}</td><td>{t.total_interrupts}</td>
                      <td>{t.cooldown_until_event_index ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === "state" && <pre className="dd-json">{JSON.stringify(s, null, 2)}</pre>}

        {tab === "views" && (
          <div className="dd-views">
            <div className="dd-sub">
              私有视图:{" "}
              <select value={viewPlayer} onChange={(e) => setViewPlayer(e.target.value as PlayerId)}>
                {SEAT_ORDER.map((id) => (
                  <option key={id} value={id}>{playerLabel(id)}({roleLabel(s.players[id].role)})</option>
                ))}
              </select>
            </div>
            <pre className="dd-json">{JSON.stringify(s.players[viewPlayer].private_view, null, 2)}</pre>
            <h4>公开视图 (PublicGameView)</h4>
            <pre className="dd-json">{JSON.stringify(god.public_view, null, 2)}</pre>
          </div>
        )}

        {tab === "events" && (
          <div className="dd-events">
            {[...s.event_log].reverse().map((e) => (
              <div key={e.event_id} className="dd-event">
                <span className="dd-ev-type">{e.type}</span>
                <span className="dd-ev-body">{truncate(JSON.stringify(e), 200)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dd-foot">
        实时:{notices.slice(-1).map((n, i) => <span key={i}>{noticeText(n)}</span>)}
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function usageText(u: {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): string {
  const read = u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  return `${u.input_tokens ?? 0}/${u.output_tokens ?? 0}/${read}/${write}`;
}

function noticeText(n: LiveNotice): string {
  switch (n.kind) {
    case "model_call_started":
      return `${playerLabel(n.player)} 正在调用 ${n.model}(${n.prompt_type})…`;
    case "model_call_completed":
      return `${playerLabel(n.player)} 用时 ${n.latency_ms}ms ${n.ok ? "✓" : "✗"}`;
    case "model_action_rejected":
      return `${playerLabel(n.player)} 被拒:${n.reason}`;
    case "game_over":
      return `游戏结束:${n.winner === "good" ? "正义方" : "邪恶方"} — ${n.reason}`;
    case "notice":
      return n.message;
    default:
      return "";
  }
}
