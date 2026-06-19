import { useEffect, useRef, useState } from "react";
import {
  SEAT_ORDER,
  playerLabel,
  type PlayerId,
  type PrivatePlayerView,
  type PublicGameView,
} from "@avalon/shared";
import { api } from "../lib/api";

interface HumanControlsProps {
  gameId: string;
  pub: PublicGameView;
  humanView: PrivatePlayerView | null;
  onError: (msg: string) => void;
}

const DISCUSSION_PHASES = new Set([
  "discussion",
  "normal_speech",
  "interrupt_collect",
  "interrupt_speech",
  "directed_reply",
]);

export function HumanControls({ gameId, pub, humanView, onError }: HumanControlsProps) {
  const seat = pub.human_seat;
  const [speech, setSpeech] = useState("");
  const [team, setTeam] = useState<PlayerId[]>([]);
  const [target, setTarget] = useState<PlayerId | "">("");
  const [assassinTarget, setAssassinTarget] = useState<PlayerId | "">("");
  const [assassinSpeech, setAssassinSpeech] = useState("");
  const [grabbed, setGrabbed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const pending = pub.pending_human;
  const myTurn = pending?.player === seat;
  const pendingKey = pending
    ? `${pending.player}:${pending.prompt_type}:${pub.phase}:${pub.quest_index}:${pub.proposal_attempt}:${pub.current_speaker ?? ""}`
    : `none:${pub.phase}:${pub.status}`;

  useEffect(() => {
    if (myTurn || !DISCUSSION_PHASES.has(pub.phase) || pub.status === "completed") {
      setGrabbed(false);
    }
  }, [myTurn, pub.phase, pub.status]);

  useEffect(() => {
    submittingRef.current = false;
    setSubmitting(false);
  }, [pendingKey]);

  if (!seat) return null;

  const send = async (action: { action?: string } & Record<string, unknown>) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await api.humanAction(gameId, action);
      setSpeech("");
      setTeam([]);
      setTarget("");
      setAssassinTarget("");
      setAssassinSpeech("");
      setGrabbed(action.action === "request_interrupt");
    } catch (e) {
      submittingRef.current = false;
      setSubmitting(false);
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const others = SEAT_ORDER.filter((id) => id !== seat);
  const canAssassinate = humanView?.role === "Assassin" && pub.status !== "completed";

  // Floor-grab is available during AI discussion when it isn't already my turn
  // and I am not about to receive the normal floor anyway.
  const canGrab =
    !myTurn &&
    !grabbed &&
    pub.status === "running" &&
    DISCUSSION_PHASES.has(pub.phase) &&
    pub.current_speaker !== seat &&
    pub.next_normal_speaker !== seat;

  let body: React.ReactNode = null;
  if (myTurn && pending) {
    switch (pending.prompt_type) {
      case "vote":
        body = (
          <div className="hc-row">
            <span className="hc-label">轮到你投票{pub.proposed_team ? `(队伍 ${pub.proposed_team.join("-")})` : ""}</span>
            <button className="primary" onClick={() => send({ action: "vote", approve: true })} type="button">赞成</button>
            <button onClick={() => send({ action: "vote", approve: false })} type="button">否决</button>
          </div>
        );
        break;
      case "mission": {
        const isGood = humanView?.alignment === "good";
        body = (
          <div className="hc-row">
            <span className="hc-label">出任务牌{isGood ? "(你是正义方,只能成功)" : ""}</span>
            <button className="primary" onClick={() => send({ action: "mission_card", card: "success" })} type="button">成功</button>
            {!isGood && (
              <button onClick={() => send({ action: "mission_card", card: "fail" })} type="button">失败</button>
            )}
          </div>
        );
        break;
      }
      case "full_speech":
      case "full_speech_optional":
        body = (
          <div className="hc-row">
            <span className="hc-label">
              {pub.phase === "interrupt_speech" ? "抢断成功,现在发言" : "轮到你发言"}
              {pending.prompt_type === "full_speech_optional" ? "(第一轮,没什么说的可以过)" : ""}
            </span>
            <select value={target} onChange={(e) => setTarget(e.target.value as PlayerId | "")}>
              <option value="">对全桌</option>
              {others.map((id) => <option key={id} value={id}>对 {playerLabel(id)}</option>)}
            </select>
            <input className="hc-input" value={speech} onChange={(e) => setSpeech(e.target.value)} placeholder="说点什么…" />
            <button className="primary" disabled={!speech.trim()} onClick={() => send({ action: "speak", target: target || null, speech: speech.trim() })} type="button">发言</button>
            {pending.prompt_type === "full_speech_optional" && (
              <button onClick={() => send({ action: "pass" })} type="button">过</button>
            )}
          </div>
        );
        break;
      case "leader_discussion": {
        const size = pub.quest_history[pub.quest_index]?.required_players ?? 2;
        const toggle = (id: PlayerId) =>
          setTeam((t) => (t.includes(id) ? t.filter((x) => x !== id) : t.length < size ? [...t, id] : t));
        body = (
          <div className="hc-row wrap">
            <span className="hc-label">你是队长:先聊或发车(选 {size} 人,已选 {team.length})</span>
            <select value={target} onChange={(e) => setTarget(e.target.value as PlayerId | "")}>
              <option value="">对全桌</option>
              {others.map((id) => <option key={id} value={id}>对 {playerLabel(id)}</option>)}
            </select>
            {SEAT_ORDER.map((id) => (
              <button key={id} className={team.includes(id) ? "active" : ""} onClick={() => toggle(id)} type="button">{id}</button>
            ))}
            <input className="hc-input" value={speech} onChange={(e) => setSpeech(e.target.value)} placeholder="发言或发车理由…" />
            <button disabled={!speech.trim()} onClick={() => send({ action: "speak", target: target || null, speech: speech.trim() })} type="button">先发言</button>
            <button className="primary" disabled={team.length !== size} onClick={() => send({ action: "propose_team", team, speech: speech.trim() || undefined })} type="button">正式发车</button>
          </div>
        );
        break;
      }
      case "leader_proposal": {
        const size = pub.quest_history[pub.quest_index]?.required_players ?? 2;
        const toggle = (id: PlayerId) =>
          setTeam((t) => (t.includes(id) ? t.filter((x) => x !== id) : t.length < size ? [...t, id] : t));
        body = (
          <div className="hc-row wrap">
            <span className="hc-label">你来发车(选 {size} 人,已选 {team.length})</span>
            {SEAT_ORDER.map((id) => (
              <button key={id} className={team.includes(id) ? "active" : ""} onClick={() => toggle(id)} type="button">{id}</button>
            ))}
            <input className="hc-input" value={speech} onChange={(e) => setSpeech(e.target.value)} placeholder="发车理由(可选)" />
            <button className="primary" disabled={team.length !== size} onClick={() => send({ action: "propose_team", team, speech: speech.trim() || undefined })} type="button">发车</button>
          </div>
        );
        break;
      }
      case "assassination":
        body = (
          <div className="hc-row idle">
            <span className="hc-label">最终刺杀:使用下方刺杀栏选择目标</span>
          </div>
        );
        break;
      case "assassination_decision":
        body = (
          <div className="hc-row">
            <span className="hc-label">🗡️ 第二轮刺杀讨论</span>
            <input className="hc-input" value={speech} onChange={(e) => setSpeech(e.target.value)} placeholder="继续讨论…" />
            <button disabled={!speech.trim()} onClick={() => send({ action: "speak", target: null, speech: speech.trim() })} type="button">继续讨论</button>
          </div>
        );
        break;
      case "postgame_review":
        body = (
          <div className="hc-row">
            <span className="hc-label">赛后复盘</span>
            <input
              className="hc-input"
              value={speech}
              onChange={(e) => setSpeech(e.target.value)}
              placeholder="聊聊这局哪里做得好、哪里能改进…"
            />
            <button className="primary" disabled={!speech.trim()} onClick={() => send({ action: "speak", target: null, speech: speech.trim() })} type="button">提交复盘</button>
            <button onClick={() => send({ action: "speak", target: null, speech: "我这轮先跳过复盘。" })} type="button">跳过</button>
          </div>
        );
        break;
      default:
        body = <div className="hc-row"><span className="hc-label">等待你的操作:{pending.prompt_type}</span></div>;
    }
  } else if (canGrab) {
    body = (
      <div className="hc-row">
        <span className="hc-label">想抢断?你有最高优先权</span>
        <input className="hc-input" value={speech} onChange={(e) => setSpeech(e.target.value)} placeholder="你的插话…" />
        <button className="primary" onClick={() => send({ action: "request_interrupt", target: null, speech: speech.trim() || undefined })} type="button">抢断</button>
      </div>
    );
  } else if (grabbed) {
    body = (
      <div className="hc-row idle">
        <span className="hc-label">抢断已提交 · 等待当前发言结束后给你最高优先权</span>
      </div>
    );
  } else {
    body = <div className="hc-row idle"><span className="hc-label">你是{playerLabel(seat)} · 等待轮到你或可抢话时机…</span></div>;
  }

  const assassinRow = canAssassinate ? (
    <fieldset className="hc-action-set hc-assassin" disabled={submitting}>
      <span className="hc-label">刺客即时刺杀</span>
      <select value={assassinTarget} onChange={(e) => setAssassinTarget(e.target.value as PlayerId | "")}>
        <option value="">选择目标</option>
        {others.map((id) => <option key={id} value={id}>{playerLabel(id)}</option>)}
      </select>
      <input
        className="hc-input"
        value={assassinSpeech}
        onChange={(e) => setAssassinSpeech(e.target.value)}
        placeholder="理由(可选)"
      />
      <button
        className="danger"
        disabled={!assassinTarget}
        onClick={() => send({ action: "assassinate", target: assassinTarget, speech: assassinSpeech.trim() || undefined })}
        type="button"
      >
        刺杀
      </button>
    </fieldset>
  ) : null;

  return (
    <div className={`human-panel ${myTurn ? "active" : ""}`} aria-busy={submitting}>
      <div className="hc-main">
        <span className="hc-seat">你 = {playerLabel(seat)}</span>
        <fieldset className="hc-action-set" disabled={submitting}>
          {body}
        </fieldset>
      </div>
      {assassinRow}
    </div>
  );
}
