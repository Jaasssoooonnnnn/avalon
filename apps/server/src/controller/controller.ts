/**
 * GameController — the authoritative host, referee, scheduler, and the only
 * writer of game state. Models propose actions; the controller validates,
 * arbitrates, and commits events. The frontend only renders.
 *
 * Granularity: advance() performs exactly one controller action (one speech,
 * one interrupt resolution, one vote round, one mission, etc.). Auto-run loops
 * advance(); single-step calls it once.
 */

import {
  AUTO_SPEED_MS,
  DIRECTED_DIALOGUE_MAX_EXCHANGES,
  MAX_INTERRUPT_SPEECHES_PER_PHASE,
  PROMPT_ALLOWED_ACTIONS,
  SCHEMA_NAME_BY_PROMPT,
  SEAT_ORDER,
  alignmentLabel,
  playerLabel,
  roleLabel,
  type AutoSpeed,
  type ExportBundle,
  type GameConfig,
  type GamePhase,
  type GameState,
  type GameSummary,
  type GodView,
  type ModelCallInput,
  type ModelCallRecord,
  type ModelName,
  type PlayerAction,
  type PlayerId,
  type PrivatePlayerView,
  type PromptType,
  type PublicGameView,
  type ReasoningEffort,
  type RevealedIdentities,
  type Role,
  type WsServerMessage,
} from "@avalon/shared";
import type { ServerConfig } from "../config.js";
import {
  getLastPublicSpeechEvent,
  publicSpeechCount,
  type EventDraft,
} from "../game/events.js";
import {
  evilReachedQuestGoal,
  failCardsRequired,
  goodReachedQuestGoal,
  nextLeader,
  rejectionsExhausted,
  resolveMission,
  tallyVotes,
} from "../game/rules.js";
import { createInitialState } from "../game/state.js";
import { toGodView, toPublicGameView } from "../game/views.js";
import { stampEvent } from "../game/events.js";
import { createAdapter, type ModelAdapter } from "../models/adapter.js";
import { IdGen } from "../utils/ids.js";
import { makeRng, type Rng } from "../utils/random.js";
import { sleep } from "../utils/async.js";
import { fallbackAction } from "./fallback.js";
import {
  computeInterruptPlayerPriority,
  computeInterruptScore,
  cooldownTargetAfterInterrupt,
  isEligibleInterruptRequester,
  makeInterruptRequest,
  pruneExpiredInterrupts,
  selectWinningInterrupt,
} from "./interrupts.js";
import { validateAction } from "./validate.js";

const MAJOR_PHASES: ReadonlySet<GamePhase> = new Set([
  "role_reveal_private",
  "discussion",
  "leader_proposal",
  "team_vote",
  "vote_reveal",
  "mission_action",
  "mission_reveal",
  "assassination_discuss",
  "assassination",
  "game_over",
]);

const MAX_MODEL_CALL_RECORDS = 60;

function rotateAfter(order: PlayerId[], pivot: PlayerId): PlayerId[] {
  const i = order.indexOf(pivot);
  if (i === -1) return order.slice();
  return [...order.slice(i + 1), ...order.slice(0, i + 1)];
}

function speechMentionsPlayer(speech: string, player: PlayerId): boolean {
  if (speech.includes(playerLabel(player))) return true;
  return new RegExp(`(^|[^A-Z])${player}([^A-Z]|$)`).test(speech);
}

function speechLooksAccusatory(speech: string): boolean {
  return /坏|黑|狼|红|有问题|不认|不信|不可信|可疑|嫌疑|失败|出失败|打失败|藏牌|甩锅|扣锅|背锅|炸|塞|不干净/.test(
    speech,
  );
}

function speechClaimsOwnSuccess(speech: string): boolean {
  return /我.*(成功|没出失败|没有出失败|不是我|没炸|打的是成功|打了成功|打成功)/.test(
    speech,
  );
}

function defaultPostgameReviewState(): GameState["postgame_review"] {
  return {
    status: "not_started",
    next_index: 0,
    completed_players: [],
  };
}

type SpeakAction = Extract<PlayerAction, { action: "speak" }>;
type ProposeTeamAction = Extract<PlayerAction, { action: "propose_team" }>;

export class GameController {
  state: GameState;
  private idgen: IdGen;
  private rng: Rng;
  private adapter: ModelAdapter;
  private readonly server: ServerConfig;

  private autoRun = false;
  private looping = false;
  private lock: Promise<void> = Promise.resolve();
  private autoSpeedMs: number = AUTO_SPEED_MS.fast;
  /** Bumped once per advance(); lets ask() drop calls that outlived their step. */
  private epoch = 0;

  private changeHandlers = new Set<() => void>();
  private noticeHandlers = new Set<(m: WsServerMessage) => void>();

  /** Resolver for the action the human seat is currently being asked for. */
  private humanResolver: ((action: PlayerAction) => void) | null = null;
  private humanPrompt: PromptType | null = null;
  private postgameLooping = false;

  constructor(gameId: string, config: GameConfig, server: ServerConfig) {
    this.server = server;
    this.idgen = new IdGen();
    this.rng = makeRng(config.seed);
    this.adapter = createAdapter(server, config);
    this.state = createInitialState(gameId, config, this.idgen, this.rng);
    this.recomputeStatuses();
  }

  /** Wrap a persisted GameState in a controller for viewing/resuming. */
  static restore(state: GameState, server: ServerConfig): GameController {
    const c = new GameController(state.game_id, state.config, server);
    c.state = state;
    // Advance id counters past anything in the loaded log so new events don't collide.
    const ids: string[] = [];
    for (const e of state.event_log) {
      ids.push(e.event_id);
      if (e.type === "interrupt_requested" || e.type === "interrupt_granted") ids.push(e.request_id);
    }
    for (const r of state.interrupts.queue) ids.push(r.request_id);
    c.idgen.prime(ids);
    // A game saved mid-run has no active loop after restart; present it as paused.
    if (c.state.status === "running") c.state.status = "paused";
    // `pending_human` is backed by an in-memory Promise resolver, so it cannot
    // survive process restore. Resume/step will recreate the prompt from phase state.
    c.state.pending_human = null;
    c.state.postgame_review = c.state.postgame_review ?? defaultPostgameReviewState();
    c.autoRun = false;
    c.recomputeStatuses();
    return c;
  }

  summary(): GameSummary {
    const s = this.state;
    const models = {} as Record<PlayerId, ModelName>;
    for (const id of s.seat_order) models[id] = s.players[id].model;
    return {
      game_id: s.game_id,
      status: s.status,
      phase: s.phase,
      winner: s.winner,
      game_over_reason: s.game_over_reason,
      quest_index: s.round.quest_index,
      created_at: s.created_at,
      mock: s.config.mock,
      models,
      num_events: s.event_log.length,
    };
  }

  // ----- subscriptions -----------------------------------------------------

  onChange(cb: () => void): () => void {
    this.changeHandlers.add(cb);
    return () => this.changeHandlers.delete(cb);
  }
  onNotice(cb: (m: WsServerMessage) => void): () => void {
    this.noticeHandlers.add(cb);
    return () => this.noticeHandlers.delete(cb);
  }
  private fireChange(): void {
    for (const h of this.changeHandlers) {
      try {
        h();
      } catch {
        /* ignore listener errors */
      }
    }
  }
  private notice(m: WsServerMessage): void {
    for (const h of this.noticeHandlers) {
      try {
        h(m);
      } catch {
        /* ignore */
      }
    }
  }

  // ----- views -------------------------------------------------------------

  getState(): GameState {
    return this.state;
  }
  getPublicView(): PublicGameView {
    return toPublicGameView(this.state);
  }
  getGodView(): GodView {
    return toGodView(this.state);
  }
  /** The human player's OWN private view (role + secret). Served only via the
   * dedicated human-view endpoint — never folded into PublicGameView. */
  humanPrivateView(): PrivatePlayerView | null {
    const seat = this.state.config.human_seat;
    return seat ? this.state.players[seat].private_view : null;
  }
  isOver(): boolean {
    return this.state.status === "completed";
  }

  setAutoSpeed(speed: AutoSpeed): void {
    this.autoSpeedMs = AUTO_SPEED_MS[speed];
  }

  // ----- lifecycle controls ------------------------------------------------

  start(): void {
    if (this.state.status === "completed") return;
    this.bootstrap();
    this.state.status = "running";
    this.autoRun = true;
    this.fireChange();
    void this.loop();
  }

  pause(): void {
    this.autoRun = false;
    if (this.state.status === "running") this.state.status = "paused";
    this.fireChange();
  }

  resume(): void {
    if (this.state.status === "completed") return;
    this.bootstrap();
    this.state.status = "running";
    this.autoRun = true;
    this.fireChange();
    void this.loop();
  }

  /** Advance exactly one controller action and pause (manual stepping). */
  async step(): Promise<void> {
    if (this.state.status === "completed") return;
    this.bootstrap();
    this.autoRun = false;
    await this.runOne();
    if (this.state.status === "running") this.state.status = "paused";
    this.fireChange();
  }

  startPostgameReview(): { ok: boolean; reason?: string } {
    if (this.state.status !== "completed") {
      return { ok: false, reason: "对局尚未结束" };
    }
    this.state.postgame_review = this.state.postgame_review ?? defaultPostgameReviewState();
    if (this.state.postgame_review.status === "completed") return { ok: true };
    if (this.state.postgame_review.status === "not_started") {
      this.epoch += 1;
      this.autoRun = false;
      this.state.postgame_review = {
        status: "running",
        next_index: 0,
        completed_players: [],
      };
      if (!this.hasPostgameRoleReveal()) {
        this.commit({
          type: "postgame_roles_revealed",
          identities: this.revealedIdentities(),
        });
      }
      this.recomputeStatuses();
      this.fireChange();
    }
    void this.runPostgameReviewLoop();
    return { ok: true };
  }

  async restart(): Promise<void> {
    this.autoRun = false;
    // Unstick any in-flight human wait so the lock chain can drain.
    if (this.humanResolver) {
      const resolve = this.humanResolver;
      this.humanResolver = null;
      this.humanPrompt = null;
      resolve({ action: "pass" });
    }
    // Let any running advance() settle BEFORE installing the fresh state. The
    // in-flight step keeps mutating the OLD state object (which we then discard),
    // so it can never write votes/events/phase transitions into the new game.
    await this.lock.catch(() => {
      /* a failed step still drains the lock; ignore */
    });
    // Invalidate any straggler model call still in flight (e.g. a late
    // interrupt-intent) so it short-circuits instead of committing to the new game.
    this.epoch += 1;
    this.idgen = new IdGen();
    this.rng = makeRng(this.state.config.seed);
    this.adapter = createAdapter(this.server, this.state.config);
    this.state = createInitialState(this.state.game_id, this.state.config, this.idgen, this.rng);
    this.recomputeStatuses();
    this.fireChange();
  }

  /** Run to completion with no inter-step delay (tests / headless). */
  async runToCompletion(maxSteps = 20000): Promise<void> {
    this.bootstrap();
    this.state.status = "running";
    let steps = 0;
    while (this.state.status === "running" && steps < maxSteps) {
      await this.runOne();
      steps += 1;
    }
  }

  private bootstrap(): void {
    if (this.state.status === "not_started") {
      this.state.status = "running";
      this.setPhase("role_reveal_private");
    }
  }

  private async loop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    try {
      while (this.autoRun && this.state.status === "running") {
        await this.runOne();
        if (this.state.status !== "running") break;
        if (this.autoSpeedMs > 0) await sleep(this.autoSpeedMs);
      }
    } finally {
      this.looping = false;
    }
  }

  /** Serialized single advance + status recompute + change broadcast. */
  private runOne(): Promise<void> {
    this.lock = this.lock.then(async () => {
      if (this.state.status === "completed") return;
      this.epoch += 1;
      try {
        await this.advance();
      } catch (e) {
        this.state.status = "paused";
        this.autoRun = false;
        this.notice({
          kind: "notice",
          message: `控制器错误:${e instanceof Error ? e.message : String(e)}`,
        });
      }
      this.recomputeStatuses();
      this.fireChange();
    });
    return this.lock;
  }

  // ----- event commit ------------------------------------------------------

  private commit(draft: EventDraft) {
    const ev = stampEvent(this.idgen, draft);
    this.state.event_log.push(ev);
    return ev;
  }

  private setPhase(to: GamePhase): void {
    const from = this.state.phase;
    if (from === to) return;
    this.state.phase = to;
    if (MAJOR_PHASES.has(to)) this.commit({ type: "phase_changed", from, to });
  }

  private ensurePostgameReviewState(): GameState["postgame_review"] {
    if (!this.state.postgame_review) {
      this.state.postgame_review = defaultPostgameReviewState();
    }
    return this.state.postgame_review;
  }

  private hasPostgameRoleReveal(): boolean {
    return this.state.event_log.some((e) => e.type === "postgame_roles_revealed");
  }

  private revealedIdentities(): RevealedIdentities {
    const identities = {} as RevealedIdentities;
    for (const id of this.state.seat_order) {
      const p = this.state.players[id];
      identities[id] = { role: p.role, alignment: p.alignment };
    }
    return identities;
  }

  private postgameReviewContextFor(player: PlayerId): string {
    const identities = this.revealedIdentities();
    const identityLines = this.state.seat_order
      .map((id) => {
        const info = identities[id];
        return `${id}:${roleLabel(info.role)}(${alignmentLabel(info.alignment)})`;
      })
      .join("，");
    const me = this.state.players[player];
    const won =
      this.state.winner === null
        ? "胜负未知"
        : this.state.winner === me.alignment
          ? "你的阵营赢了"
          : "你的阵营输了";
    return (
      `【赛后身份公开】${identityLines}。\n` +
      `【赛果】${this.state.winner ? alignmentLabel(this.state.winner) : "未知阵营"}获胜。` +
      `${this.state.game_over_reason ?? ""}\n` +
      `【你的复盘视角】你是${playerLabel(player)}:${roleLabel(me.role)}(${alignmentLabel(me.alignment)}),${won}。` +
      "请做赛后复盘:可以表达惊讶/后悔/夸赞;赢了说哪里做得好和还能改进,输了说自己哪里没做好以及下次怎么改。"
    );
  }

  private validatePostgameReviewAction(
    player: PlayerId,
    action: PlayerAction,
  ): { ok: boolean; reason?: string } {
    if (!this.state.players[player]) return { ok: false, reason: `unknown player ${player}` };
    if (this.state.status !== "completed") return { ok: false, reason: "对局尚未结束" };
    const review = this.ensurePostgameReviewState();
    if (review.status !== "running" && review.status !== "waiting_human") {
      return { ok: false, reason: "赛后复盘尚未开始" };
    }
    if (this.state.round.current_speaker !== player) {
      return { ok: false, reason: "现在不轮到该玩家复盘" };
    }
    if (action.action !== "speak") {
      return { ok: false, reason: "赛后复盘只能发言" };
    }
    if (action.target != null && !this.state.players[action.target]) {
      return { ok: false, reason: `invalid speech target ${action.target}` };
    }
    if (!action.speech.trim()) return { ok: false, reason: "复盘发言不能为空" };
    return { ok: true };
  }

  private fallbackPostgameReview(player: PlayerId): SpeakAction {
    const action = fallbackAction(this.state, player, "postgame_review");
    if (action.action === "speak") return action;
    return {
      action: "speak",
      target: null,
      speech: "这局我先简单复盘到这里,下次要把关键票型和任务责任看得更清楚。",
    };
  }

  private async askPostgameReview(
    player: PlayerId,
  ): Promise<{ action: SpeakAction; accepted: boolean }> {
    const contextNote = this.postgameReviewContextFor(player);
    const epoch = this.epoch;

    if (player === this.state.config.human_seat) {
      const action = await this.awaitHuman(player, "postgame_review", contextNote);
      if (this.epoch !== epoch || this.state.status !== "completed") {
        return { action: this.fallbackPostgameReview(player), accepted: false };
      }
      const v = this.validatePostgameReviewAction(player, action);
      if (v.ok && action.action === "speak") return { action, accepted: true };
      this.notice({ kind: "model_action_rejected", player, reason: v.reason ?? "rejected" });
      return { action: this.fallbackPostgameReview(player), accepted: false };
    }

    const input: ModelCallInput = {
      player_id: player,
      model: this.state.players[player].model,
      phase: this.state.phase,
      prompt_type: "postgame_review",
      private_view: this.state.players[player].private_view,
      public_view: this.getPublicView(),
      legal_actions: PROMPT_ALLOWED_ACTIONS.postgame_review,
      schema_name: SCHEMA_NAME_BY_PROMPT.postgame_review,
      context_note: contextNote,
      effort: "medium",
    };

    this.notice({ kind: "model_call_started", player, prompt_type: "postgame_review", model: input.model });
    const result = await this.adapter.generateAction(input);
    this.notice({
      kind: "model_call_completed",
      player,
      prompt_type: "postgame_review",
      latency_ms: result.latency_ms,
      ok: result.parsed_action !== null,
    });

    if (this.epoch !== epoch) {
      return { action: this.fallbackPostgameReview(player), accepted: false };
    }

    this.commit({
      type: "model_raw_response",
      player,
      prompt_type: "postgame_review",
      raw: result.raw_text,
      visibility: "god_only",
    });

    let action = result.parsed_action;
    let accepted = true;
    let rejectReason: string | undefined;

    if (!action) {
      accepted = false;
      rejectReason = result.error ?? "no valid action produced";
    } else {
      const v = this.validatePostgameReviewAction(player, action);
      if (!v.ok) {
        accepted = false;
        rejectReason = v.reason;
      }
    }

    if (!accepted) {
      this.commit({
        type: "model_action_rejected",
        player,
        action: (result.parsed_action ?? result.raw_text) as unknown,
        reason: rejectReason ?? "rejected",
        visibility: "god_only",
      });
      this.notice({ kind: "model_action_rejected", player, reason: rejectReason ?? "rejected" });
      action = this.fallbackPostgameReview(player);
    } else if (action) {
      this.recordPrivateMemo(player, action);
    }

    this.pushModelCall({
      player,
      model: input.model,
      prompt_type: "postgame_review",
      phase: this.state.phase,
      raw_text: result.raw_text,
      parsed_action: result.parsed_action,
      accepted,
      reject_reason: rejectReason,
      latency_ms: result.latency_ms,
      usage: result.usage,
      timestamp: Date.now(),
    });

    return { action: action as SpeakAction, accepted };
  }

  private async runPostgameReviewLoop(): Promise<void> {
    if (this.postgameLooping) return;
    this.postgameLooping = true;
    try {
      while (true) {
        if (this.state.status !== "completed") return;
        const review = this.ensurePostgameReviewState();
        if (review.status === "completed") return;
        if (review.next_index >= this.state.seat_order.length) {
          review.status = "completed";
          this.state.round.current_speaker = null;
          this.state.round.next_normal_speaker = null;
          this.recomputeStatuses();
          this.fireChange();
          return;
        }

        const player = this.state.seat_order[review.next_index]!;
        review.status = player === this.state.config.human_seat ? "waiting_human" : "running";
        this.state.round.current_speaker = player;
        this.state.round.next_normal_speaker = this.state.seat_order[review.next_index + 1] ?? null;
        this.recomputeStatuses();
        this.fireChange();

        const { action } = await this.askPostgameReview(player);
        if (this.state.status !== "completed") return;
        const current = this.ensurePostgameReviewState();
        if (current.status === "completed") return;
        if (this.state.seat_order[current.next_index] !== player) continue;

        this.commit({
          type: "public_speech",
          player,
          target: action.target ?? null,
          speech: action.speech,
          source: "postgame_review",
        });
        if (!current.completed_players.includes(player)) current.completed_players.push(player);
        current.next_index += 1;
        current.status =
          current.next_index >= this.state.seat_order.length ? "completed" : "running";
        this.state.round.current_speaker = null;
        this.state.round.next_normal_speaker = this.state.seat_order[current.next_index] ?? null;
        this.recomputeStatuses();
        this.fireChange();
      }
    } finally {
      this.postgameLooping = false;
    }
  }

  // ----- model interaction -------------------------------------------------

  private pushModelCall(rec: ModelCallRecord): void {
    this.state.last_model_calls.push(rec);
    if (this.state.last_model_calls.length > MAX_MODEL_CALL_RECORDS) {
      this.state.last_model_calls.splice(
        0,
        this.state.last_model_calls.length - MAX_MODEL_CALL_RECORDS,
      );
    }
  }

  private recordPrivateMemo(player: PlayerId, action: PlayerAction): void {
    const memo = "memo" in action ? action.memo?.trim() : undefined;
    if (!memo) return;
    const view = this.state.players[player].private_view;
    if (!Array.isArray(view.notes)) view.notes = [];
    view.notes.push(memo);
    this.commit({ type: "private_memo", player, memo, visibility: "god_only" });
  }

  /** Ask one model for an action, validate it, fall back to a legal default. */
  private async ask(
    player: PlayerId,
    promptType: PromptType,
    contextNote?: string,
    effort?: ReasoningEffort,
  ): Promise<{ action: PlayerAction; accepted: boolean }> {
    // Human seat: pause the game and wait for the player's input from the UI.
    if (player === this.state.config.human_seat) {
      const action = await this.awaitHuman(player, promptType, contextNote);
      if (this.state.status === "completed") return { action, accepted: false };
      return { action, accepted: true };
    }

    const input: ModelCallInput = {
      player_id: player,
      model: this.state.players[player].model,
      phase: this.state.phase,
      prompt_type: promptType,
      private_view: this.state.players[player].private_view,
      public_view: this.getPublicView(),
      legal_actions: PROMPT_ALLOWED_ACTIONS[promptType],
      schema_name: SCHEMA_NAME_BY_PROMPT[promptType],
      context_note: contextNote,
      effort,
    };

    this.notice({ kind: "model_call_started", player, prompt_type: promptType, model: input.model });
    const epoch = this.epoch;
    const result = await this.adapter.generateAction(input);

    // Always clear the UI "thinking" indicator (ephemeral signal, not logged).
    this.notice({
      kind: "model_call_completed",
      player,
      prompt_type: promptType,
      latency_ms: result.latency_ms,
      ok: result.parsed_action !== null,
    });

    // If this call outlived its advance() (e.g., a late interrupt-intent that
    // resolved after the collection window closed), drop it from the GOD LOG:
    // skip commits + debug record. The UI indicator was already cleared above.
    if (this.epoch !== epoch) {
      return {
        action: result.parsed_action ?? fallbackAction(this.state, player, promptType),
        accepted: false,
      };
    }

    this.commit({
      type: "model_raw_response",
      player,
      prompt_type: promptType,
      raw: result.raw_text,
      visibility: "god_only",
    });

    let action = result.parsed_action;
    let accepted = true;
    let rejectReason: string | undefined;

    if (!action) {
      accepted = false;
      rejectReason = result.error ?? "no valid action produced";
    } else {
      const v = validateAction(this.state, player, action);
      if (!v.ok) {
        accepted = false;
        rejectReason = v.reason;
      }
    }

    if (!accepted) {
      this.commit({
        type: "model_action_rejected",
        player,
        action: (result.parsed_action ?? result.raw_text) as unknown,
        reason: rejectReason ?? "rejected",
        visibility: "god_only",
      });
      this.notice({ kind: "model_action_rejected", player, reason: rejectReason ?? "rejected" });
      action = fallbackAction(this.state, player, promptType);
    } else if (action) {
      this.recordPrivateMemo(player, action);
    }

    this.pushModelCall({
      player,
      model: input.model,
      prompt_type: promptType,
      phase: this.state.phase,
      raw_text: result.raw_text,
      parsed_action: result.parsed_action,
      accepted,
      reject_reason: rejectReason,
      latency_ms: result.latency_ms,
      usage: result.usage,
      timestamp: Date.now(),
    });

    return { action: action!, accepted };
  }

  // ----- human player ------------------------------------------------------

  /** Block until the human submits a legal action for this prompt. */
  private awaitHuman(
    player: PlayerId,
    promptType: PromptType,
    contextNote?: string,
  ): Promise<PlayerAction> {
    this.state.pending_human = {
      player,
      prompt_type: promptType,
      legal_actions: PROMPT_ALLOWED_ACTIONS[promptType],
      context_note: contextNote,
    };
    this.humanPrompt = promptType;
    this.notice({
      kind: "notice",
      message: `轮到你(玩家${player})了:${promptType}`,
    });
    this.fireChange();
    return new Promise<PlayerAction>((resolve) => {
      this.humanResolver = (action) => {
        this.state.pending_human = null;
        this.humanResolver = null;
        this.humanPrompt = null;
        this.fireChange();
        resolve(action);
      };
    });
  }

  /**
   * Submit a human action. Routes to either the pending ask, or — for a
   * `request_interrupt` during discussion — the top-priority floor grab.
   * Returns whether it was accepted (and why not).
   */
  submitHumanAction(action: PlayerAction): { ok: boolean; reason?: string } {
    const seat = this.state.config.human_seat;
    if (!seat) return { ok: false, reason: "本局没有人类玩家" };

    // Human-only rule variant: a human Assassin may end the game immediately,
    // even while another prompt or model call is in flight.
    if (action.action === "assassinate") {
      return this.submitImmediateHumanAssassination(action);
    }

    if (this.state.pending_human && !this.humanResolver) {
      this.state.pending_human = null;
      this.recomputeStatuses();
      this.fireChange();
      return { ok: false, reason: "这个操作提示已经失效,请继续/单步让系统重新轮到你" };
    }

    // Post-game review happens after `status=completed`, so it cannot use the
    // ordinary phase validator. It still only accepts the pending human's line.
    if (this.humanResolver && this.humanPrompt === "postgame_review") {
      const v = this.validatePostgameReviewAction(seat, action);
      if (!v.ok) return { ok: false, reason: v.reason };
      const resolve = this.humanResolver;
      resolve(action);
      return { ok: true };
    }

    // 1. Answer to a pending ask (vote / speak / propose / mission / assassinate).
    if (
      this.humanResolver &&
      this.humanPrompt &&
      PROMPT_ALLOWED_ACTIONS[this.humanPrompt].includes(action.action)
    ) {
      const v = validateAction(this.state, seat, action);
      if (!v.ok) return { ok: false, reason: v.reason };
      const resolve = this.humanResolver;
      resolve(action);
      return { ok: true };
    }

    // 2. Asynchronous "grab the floor" during discussion.
    if (action.action === "request_interrupt") {
      const r = this.requestHumanInterrupt(action.target ?? null, action.speech ?? "");
      return r;
    }
    if (action.action === "withdraw_interrupt") {
      this.state.interrupts.human_request = null;
      this.fireChange();
      return { ok: true };
    }
    return { ok: false, reason: "现在不轮到你,且当前无法插话" };
  }

  private submitImmediateHumanAssassination(
    action: Extract<PlayerAction, { action: "assassinate" }>,
  ): { ok: boolean; reason?: string } {
    const seat = this.state.config.human_seat;
    if (!seat) return { ok: false, reason: "本局没有人类玩家" };
    if (this.state.status === "completed") return { ok: false, reason: "对局已经结束" };
    if (this.state.players[seat].role !== "Assassin") {
      return { ok: false, reason: "只有刺客可以刺杀" };
    }
    if (!this.state.players[action.target]) {
      return { ok: false, reason: `无效刺杀目标 ${action.target}` };
    }
    if (action.target === seat) {
      return { ok: false, reason: "刺客不能刺杀自己" };
    }

    this.epoch += 1;
    this.state.interrupts.human_request = null;
    this.state.interrupts.queue = [];
    this.state.interrupts.granted = null;
    this.state.interrupts.directed_dialogue = null;

    const early = !goodReachedQuestGoal(this.state.quests);
    this.commitAssassination(seat, action, { early });

    if (this.humanResolver) {
      this.humanResolver({ action: "pass" });
    } else {
      this.state.pending_human = null;
      this.humanPrompt = null;
    }
    this.humanResolver = null;
    this.humanPrompt = null;
    this.fireChange();
    return { ok: true };
  }

  /** Queue the human's interrupt; consumed (with top priority) at the next collection. */
  requestHumanInterrupt(
    target: PlayerId | null,
    speech: string,
  ): { ok: boolean; reason?: string } {
    const seat = this.state.config.human_seat;
    if (!seat) return { ok: false, reason: "本局没有人类玩家" };
    const round = this.state.round;
    if (round.current_speaker === seat) return { ok: false, reason: "你正在发言,无需抢话" };
    if (round.next_normal_speaker === seat) {
      // The next normal speaker gets their turn anyway — same rule the AI seats
      // follow (isEligibleInterruptRequester). Reject up front so the human
      // isn't left holding a grab that can never be honored.
      return { ok: false, reason: "你本来就是下一位发言者,无需抢话" };
    }
    const discussion = new Set([
      "discussion",
      "normal_speech",
      "interrupt_collect",
      "interrupt_speech",
      "directed_reply",
    ]);
    if (!discussion.has(this.state.phase)) {
      return { ok: false, reason: "当前阶段不能抢话" };
    }
    this.state.interrupts.human_request = { target, speech };
    this.notice({ kind: "notice", message: `玩家${seat} 举手抢话` });
    this.fireChange();
    return { ok: true };
  }

  // ----- phase dispatcher --------------------------------------------------

  private async advance(): Promise<void> {
    switch (this.state.phase) {
      case "setup":
        this.setPhase("role_reveal_private");
        return;
      case "role_reveal_private":
        this.enterProposalDiscussion();
        return;
      case "leader_proposal":
        return this.handleLeaderProposal();
      case "discussion":
        return this.handleNormalSpeech();
      case "normal_speech":
        return this.handleNormalSpeech();
      case "interrupt_collect":
        return this.handleInterruptCollect();
      case "interrupt_speech":
        return this.handleInterruptSpeech();
      case "directed_reply":
        return this.handleDirectedReply();
      case "team_finalize":
        this.handleTeamFinalize();
        return;
      case "team_vote":
        return this.handleTeamVote();
      case "vote_reveal":
        this.handleVoteReveal();
        return;
      case "mission_action":
        return this.handleMissionAction();
      case "mission_reveal":
        this.handleMissionReveal();
        return;
      case "assassination_discuss":
        return this.handleAssassinationDiscuss();
      case "assassination":
        return this.handleAssassination();
      case "game_over":
        return;
      default:
        return;
    }
  }

  // ----- phase handlers ----------------------------------------------------

  private async handleLeaderProposal(): Promise<void> {
    const leader = this.state.round.leader;
    this.state.round.current_speaker = leader;
    this.state.round.next_normal_speaker = null;
    const { action } = await this.ask(
      leader,
      "leader_proposal",
      "整轮讨论已经结束,现在你必须正式发车。",
      "medium",
    );
    if (this.state.status === "completed") return;
    this.commitTeamProposalAndOpenInterrupts(action as ProposeTeamAction);
  }

  private enterProposalDiscussion(): void {
    const leader = this.state.round.leader;
    const order = [
      leader,
      ...rotateAfter(this.state.seat_order, leader).filter((p) => p !== leader),
    ];
    this.state.round.normal_queue = order;
    this.state.round.normal_speech_index = 0;
    this.state.round.current_speaker = null;
    this.state.round.next_normal_speaker = order[0] ?? null;
    this.state.round.proposed_team = null;
    this.state.interrupts.queue = [];
    this.state.interrupts.phase_budget_remaining = MAX_INTERRUPT_SPEECHES_PER_PHASE;
    this.state.interrupts.directed_dialogue = null;
    this.state.interrupts.granted = null;
    this.state.interrupts.arrival_counter = 0;
    this.state.interrupts.human_request = null;
    for (const p of SEAT_ORDER) {
      const ts = this.state.talk_stats[p];
      ts.normal_speeches_in_phase = 0;
      ts.interrupts_in_phase = 0;
      ts.cooldown_until_event_index = null;
    }
    this.setPhase("discussion");
  }

  private shouldAskLeaderDiscussion(player: PlayerId): boolean {
    return player === this.state.round.leader && this.state.round.proposed_team === null;
  }

  private commitTeamProposalAndOpenInterrupts(prop: ProposeTeamAction): void {
    const leader = this.state.round.leader;
    const round = this.state.round;
    round.proposed_team = prop.team.slice();
    this.commit({ type: "team_proposed", leader, team: prop.team.slice(), speech: prop.speech });
    if (prop.speech) {
      this.commit({
        type: "public_speech",
        player: leader,
        target: null,
        speech: prop.speech,
        source: "leader_final",
      });
      this.state.talk_stats[leader].last_spoke_event_index = publicSpeechCount(this.state);
    }
    round.current_speaker = leader;
    round.normal_queue = round.normal_queue.filter((p) => p !== leader);
    round.next_normal_speaker = round.normal_queue[0] ?? null;
    this.state.interrupts.queue = [];
    this.state.interrupts.directed_dialogue = null;
    this.state.interrupts.granted = null;
    this.state.interrupts.human_request = null;
    this.setPhase("interrupt_collect");
  }

  private continueAfterInterruptWindow(): void {
    const round = this.state.round;
    if (round.proposed_team && round.normal_queue.length === 0) {
      this.setPhase("team_finalize");
      return;
    }
    this.setPhase("discussion");
  }

  private interruptContextFor(player: PlayerId): string | undefined {
    const last = getLastPublicSpeechEvent(this.state);
    if (!last || last.player === player) return undefined;

    const directTarget = last.target === player;
    const mentioned = directTarget || speechMentionsPlayer(last.speech, player);
    if (!mentioned) return undefined;
    if (!directTarget && !speechLooksAccusatory(last.speech)) return undefined;

    const lastFailedDuel = this.state.quests
      .slice()
      .reverse()
      .find((q) => q.result === "fail" && q.team?.length === 2 && q.team.includes(player));
    const duelNote =
      lastFailedDuel && speechClaimsOwnSuccess(last.speech)
        ? "这属于二人失败车互扣锅场景。"
        : "";

    return (
      `刚才${playerLabel(last.player)}的发言${directTarget ? "直接点名" : "提到并质疑"}了你。` +
      duelNote +
      "如果他在把任务失败、坏身份或队伍责任扣到你身上,而你不是下一位正常发言者,通常应申请插话;即使不抢,轮到你时也要正面回应。"
    );
  }

  private async handleNormalSpeech(): Promise<void> {
    const round = this.state.round;
    if (round.normal_queue.length === 0) {
      round.current_speaker = null;
      round.next_normal_speaker = null;
      this.setPhase(round.proposed_team ? "team_finalize" : "leader_proposal");
      return;
    }
    const speaker = round.normal_queue[0]!;
    round.current_speaker = speaker;
    round.next_normal_speaker = round.normal_queue[1] ?? null;

    // Round-1 discussion carries little information, so non-leader speakers may
    // pass their turn instead of producing filler. Later rounds stay mandatory.
    const promptType = this.shouldAskLeaderDiscussion(speaker)
      ? "leader_discussion"
      : round.quest_index === 0
        ? "full_speech_optional"
        : "full_speech";
    const contextNote =
      promptType === "full_speech_optional"
        ? "这是第一轮发车前的讨论,公开信息几乎为零,默认 {\"action\":\"pass\"} 跳过。" +
          "只有当你有具体、可复核的点才发言:明确反对某人上车并给出理由,或指出一处真实矛盾。" +
          "如果你想说的只是“先跑结果”“看票型”“这车常规/没硬伤”“第一轮信息少”这类套话,那就直接 pass,不要发。"
        : undefined;
    const { action } = await this.ask(speaker, promptType, contextNote, "medium");
    if (this.state.status === "completed") return;
    if (action.action === "propose_team") {
      this.commitTeamProposalAndOpenInterrupts(action);
      return;
    }
    if (action.action === "pass") {
      // Visible no-op: record the skip, advance to the next speaker, and do NOT
      // open an interrupt window (there is no speech to respond to).
      this.commit({ type: "speech_passed", player: speaker });
      round.normal_speech_index += 1;
      round.normal_queue.shift();
      round.current_speaker = null;
      round.next_normal_speaker = round.normal_queue[0] ?? null;
      this.setPhase("discussion");
      return;
    }
    const speak = action as SpeakAction;
    const ev = this.commit({
      type: "public_speech",
      player: speaker,
      target: speak.target ?? null,
      speech: speak.speech,
      source: "normal",
    });

    const ts = this.state.talk_stats[speaker];
    ts.normal_speeches_in_phase += 1;
    ts.last_spoke_event_index = publicSpeechCount(this.state);
    round.normal_speech_index += 1;
    round.normal_queue.shift();
    round.next_normal_speaker = round.normal_queue[0] ?? null;
    pruneExpiredInterrupts(this.state);

    const tgt = speak.target ?? null;
    if (tgt && tgt !== speaker && this.state.players[tgt]) {
      this.setupDirectedDialogue(speaker, tgt, ev.event_id);
      this.setPhase("directed_reply");
    } else {
      this.setPhase("interrupt_collect");
    }
  }

  private async handleInterruptCollect(): Promise<void> {
    pruneExpiredInterrupts(this.state);

    // The human player always wins the floor the moment they grab it.
    const human = this.state.config.human_seat;
    if (human && this.state.interrupts.human_request) {
      const r = this.state.round;
      const humanEligible = r.current_speaker !== human && r.next_normal_speaker !== human;
      if (humanEligible) {
        const reqId = this.idgen.next("req");
        this.commit({ type: "interrupt_granted", request_id: reqId, player: human });
        this.state.interrupts.granted = { request_id: reqId, player: human };
        this.state.interrupts.queue = [];
        this.setPhase("interrupt_speech");
        return;
      }
      // The human grabbed while they are the current or next speaker, so the
      // floor can't be handed over now. Drop the stale grab instead of letting
      // it fire (with a now-outdated line) at a later collection window.
      this.state.interrupts.human_request = null;
    }

    const eligible = SEAT_ORDER.filter(
      (p) => p !== human && isEligibleInterruptRequester(this.state, p),
    );
    if (this.state.interrupts.phase_budget_remaining <= 0 || eligible.length === 0) {
      this.state.interrupts.queue = [];
      this.continueAfterInterruptWindow();
      return;
    }

    const anchor =
      getLastPublicSpeechEvent(this.state)?.event_id ??
      this.state.event_log[this.state.event_log.length - 1]?.event_id ??
      "";
    await this.pollInterruptIntents(eligible, anchor);
    if (this.state.status === "completed") return;

    const winner = selectWinningInterrupt(this.state);
    if (winner && this.state.interrupts.phase_budget_remaining > 0) {
      this.commit({ type: "interrupt_granted", request_id: winner.request_id, player: winner.player });
      for (const r of this.state.interrupts.queue) {
        if (r.request_id !== winner.request_id) {
          this.commit({
            type: "interrupt_rejected",
            request_id: r.request_id,
            player: r.player,
            reason: "lost interrupt priority",
            visibility: "god_only",
          });
        }
      }
      this.state.interrupts.granted = { request_id: winner.request_id, player: winner.player };
      this.state.interrupts.queue = [];
      this.setPhase("interrupt_speech");
    } else {
      this.state.interrupts.queue = [];
      this.continueAfterInterruptWindow();
    }
  }

  /** Concurrently poll eligible players for interrupt intent within the window. */
  private async pollInterruptIntents(eligible: PlayerId[], anchorEventId: string): Promise<void> {
    // Collection deadline: same-priority requests are first-come-first-served,
    // but a lower-priority request waits for higher-priority players to answer
    // or hit the straggler cap.
    const deadlineMs = this.state.config.interrupt_window_ms;
    const pending = new Set<PlayerId>(eligible);
    let best: ReturnType<typeof makeInterruptRequest> | null = null;
    let closed = false;
    let wake: (() => void) | null = null;

    const notify = () => {
      if (wake) {
        wake();
        wake = null;
      }
    };

    const priorityOf = (player: PlayerId) => computeInterruptPlayerPriority(this.state, player);
    const better = (
      a: ReturnType<typeof makeInterruptRequest> | null,
      b: ReturnType<typeof makeInterruptRequest>,
    ) => {
      if (!a) return b;
      const priorityDiff = priorityOf(b.player) - priorityOf(a.player);
      if (priorityDiff > 0) return b;
      if (priorityDiff < 0) return a;
      const scoreDiff = computeInterruptScore(b, this.state) - computeInterruptScore(a, this.state);
      if (scoreDiff > 0) return b;
      if (scoreDiff < 0) return a;
      return b.arrival_seq < a.arrival_seq ? b : a;
    };

    const maxPendingPriority = () => {
      let max = -100000;
      for (const player of pending) max = Math.max(max, priorityOf(player));
      return max;
    };

    const canCloseNow = () => best !== null && priorityOf(best.player) >= maxPendingPriority();

    for (const p of eligible) {
      this.ask(p, "interrupt_intent", this.interruptContextFor(p), "low")
        .then((r) => {
          if (closed) return;
          pending.delete(p);
          if (this.state.status === "completed" || !r.accepted) {
            notify();
            return;
          }
          if (r.action.action === "request_interrupt") {
            const req = makeInterruptRequest(
              this.state,
              this.idgen,
              p,
              r.action.target ?? null,
              r.action.speech,
              anchorEventId,
            );
            this.state.interrupts.queue.push(req);
            this.commit({
              type: "interrupt_requested",
              request_id: req.request_id,
              player: p,
              target: req.target,
              speech: req.speech,
              anchor_event_id: anchorEventId,
              score: req.score,
              visibility: "god_only",
            });
            best = better(best, req);
          }
          notify();
        })
        .catch(() => {
          if (closed) return;
          pending.delete(p);
          notify();
        });
    }

    const deadline = Date.now() + deadlineMs;
    while (pending.size > 0 && !canCloseNow()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
        sleep(remaining),
      ]);
    }

    closed = true;
    if (pending.size > 0) {
      // Invalidate slower interrupt-intent calls so their late results only
      // clear ephemeral "thinking" UI and cannot enter this or a later queue.
      this.epoch += 1;
    }
  }

  private async handleInterruptSpeech(): Promise<void> {
    const g = this.state.interrupts.granted;
    if (!g) {
      this.setPhase("interrupt_collect");
      return;
    }
    const speaker = g.player;
    this.state.round.current_speaker = speaker;
    this.state.round.next_normal_speaker = this.state.round.normal_queue[0] ?? null;

    // The human already typed their line when grabbing the floor — use it directly.
    const isHuman = speaker === this.state.config.human_seat;
    const hr = this.state.interrupts.human_request;
    let speak: SpeakAction;
    let proposed: ProposeTeamAction | null = null;
    if (isHuman && hr && hr.speech.trim()) {
      speak = { action: "speak", target: hr.target ?? null, speech: hr.speech };
    } else {
      const { action } = await this.ask(
        speaker,
        this.shouldAskLeaderDiscussion(speaker) ? "leader_discussion" : "full_speech",
        isHuman
          ? "你抢到了发言权,请输入你的插话。"
          : "你抢到了插话的发言权——简短有力地说出你的观点。",
        "medium",
      );
      if (this.state.status === "completed") return;
      if (action.action === "propose_team") proposed = action;
      speak = action as SpeakAction;
    }
    if (isHuman) this.state.interrupts.human_request = null;
    if (proposed) {
      const ts = this.state.talk_stats[speaker];
      ts.interrupts_in_phase += 1;
      ts.interrupts_in_round += 1;
      ts.total_interrupts += 1;
      ts.cooldown_until_event_index = cooldownTargetAfterInterrupt(this.state);
      this.state.interrupts.phase_budget_remaining -= 1;
      this.state.interrupts.granted = null;
      this.commitTeamProposalAndOpenInterrupts(proposed);
      return;
    }
    const ev = this.commit({
      type: "public_speech",
      player: speaker,
      target: speak.target ?? null,
      speech: speak.speech,
      source: "interrupt",
    });

    const ts = this.state.talk_stats[speaker];
    ts.interrupts_in_phase += 1;
    ts.interrupts_in_round += 1;
    ts.total_interrupts += 1;
    ts.last_spoke_event_index = publicSpeechCount(this.state);
    ts.cooldown_until_event_index = cooldownTargetAfterInterrupt(this.state);
    this.state.interrupts.phase_budget_remaining -= 1;
    this.state.interrupts.granted = null;
    pruneExpiredInterrupts(this.state);

    const tgt = speak.target ?? null;
    if (tgt && tgt !== speaker && this.state.players[tgt]) {
      this.setupDirectedDialogue(speaker, tgt, ev.event_id);
      this.setPhase("directed_reply");
    } else {
      this.setPhase("interrupt_collect");
    }
  }

  private setupDirectedDialogue(
    initiator: PlayerId,
    target: PlayerId,
    anchorId: string,
    exchanges = 0,
    maxExchanges = DIRECTED_DIALOGUE_MAX_EXCHANGES,
  ): void {
    const merged = this.state.round.next_normal_speaker === target;
    this.state.interrupts.directed_dialogue = {
      initiator,
      target,
      exchanges,
      max_exchanges: maxExchanges,
      anchor_event_id: anchorId,
      merged_with_normal: merged,
    };
  }

  private async handleDirectedReply(): Promise<void> {
    const dd = this.state.interrupts.directed_dialogue;
    if (!dd) {
      this.setPhase("interrupt_collect");
      return;
    }
    const speaker = dd.target;
    this.state.round.current_speaker = speaker;

    const mergeNote =
      dd.merged_with_normal && dd.exchanges === 0
        ? "你同时也是下一位正常发言者——请先回应他的观点,然后接着进行你正常的讨论发言。"
        : "";
    const { action } = await this.ask(
      speaker,
      this.shouldAskLeaderDiscussion(speaker) ? "leader_discussion" : "full_speech",
      `${playerLabel(dd.initiator)} 直接点名了你。${mergeNote}`,
      "medium",
    );
    if (this.state.status === "completed") return;
    if (action.action === "propose_team") {
      this.commitTeamProposalAndOpenInterrupts(action);
      return;
    }
    const speak = action as SpeakAction;
    const ev = this.commit({
      type: "public_speech",
      player: speaker,
      target: speak.target ?? null,
      speech: speak.speech,
      source: "directed_reply",
    });
    this.state.talk_stats[speaker].last_spoke_event_index = publicSpeechCount(this.state);
    dd.exchanges += 1;
    pruneExpiredInterrupts(this.state);

    if (dd.merged_with_normal) {
      // The merged reply IS the target's normal turn — count it as a normal
      // speech (so interrupt priority / debug stats stay accurate) and remove
      // them from the queue so they don't speak again.
      const ts = this.state.talk_stats[speaker];
      ts.normal_speeches_in_phase += 1;
      this.state.round.normal_speech_index += 1;
      this.state.round.normal_queue = this.state.round.normal_queue.filter((p) => p !== speaker);
      this.state.round.next_normal_speaker = this.state.round.normal_queue[0] ?? null;
      this.state.interrupts.directed_dialogue = null;
      this.setPhase("interrupt_collect");
      return;
    }

    const tgt = speak.target ?? null;
    if (tgt && tgt !== speaker && dd.exchanges < dd.max_exchanges && this.state.players[tgt]) {
      // Bounded follow-up: either swap back to the original asker or carry the
      // directed chain to a newly addressed player.
      this.setupDirectedDialogue(speaker, tgt, ev.event_id, dd.exchanges, dd.max_exchanges);
      this.setPhase("directed_reply");
    } else {
      this.state.interrupts.directed_dialogue = null;
      this.setPhase("interrupt_collect");
    }
  }

  private handleTeamFinalize(): void {
    this.state.interrupts.queue = [];
    this.state.interrupts.directed_dialogue = null;
    this.state.interrupts.granted = null;
    this.state.interrupts.human_request = null;
    this.state.round.current_speaker = null;
    for (const p of SEAT_ORDER) this.state.votes[p] = null;
    this.setPhase("team_vote");
  }

  private async handleTeamVote(): Promise<void> {
    const voters = SEAT_ORDER.slice();
    const results = await Promise.all(voters.map((p) => this.ask(p, "vote", undefined, "medium")));
    if (this.state.status === "completed") return;
    voters.forEach((p, i) => {
      const a = results[i]!.action as Extract<PlayerAction, { action: "vote" }>;
      this.state.votes[p] = a.approve;
      this.commit({ type: "vote_cast", player: p, approve: a.approve, visibility: "god_only_until_reveal" });
    });
    const tally = tallyVotes(this.state.votes);
    this.commit({
      type: "vote_revealed",
      approvals: tally.approvals,
      rejections: tally.rejections,
      passed: tally.passed,
    });
    this.setPhase("vote_reveal");
  }

  private handleVoteReveal(): void {
    const tally = tallyVotes(this.state.votes);
    const round = this.state.round;
    if (tally.passed) {
      const qi = round.quest_index;
      this.state.quests[qi]!.team = round.proposed_team!.slice();
      this.state.quests[qi]!.leader = round.leader;
      this.state.mission.active = true;
      this.state.mission.team = round.proposed_team!.slice();
      for (const p of SEAT_ORDER) this.state.mission.cards[p] = null;
      this.setPhase("mission_action");
    } else if (rejectionsExhausted(round.proposal_attempt)) {
      this.endGame("evil", "同一任务中连续 5 次发车都被否决,邪恶方获胜。");
    } else {
      round.proposal_attempt += 1;
      round.leader = nextLeader(round.leader, this.state.seat_order);
      this.commit({ type: "leader_changed", leader: round.leader });
      this.enterProposalDiscussion();
    }
  }

  private async handleMissionAction(): Promise<void> {
    const team = this.state.mission.team.slice();
    const results = await Promise.all(team.map((p) => this.ask(p, "mission", undefined, "low")));
    if (this.state.status === "completed") return;
    team.forEach((p, i) => {
      const a = results[i]!.action as Extract<PlayerAction, { action: "mission_card" }>;
      this.state.mission.cards[p] = a.card;
      this.commit({ type: "mission_card_submitted", player: p, card: a.card, visibility: "god_only" });
    });

    const cards = team.map((p) => this.state.mission.cards[p]!);
    const qi = this.state.round.quest_index;
    const res = resolveMission(cards, failCardsRequired(qi));
    const quest = this.state.quests[qi]!;
    quest.result = res.passed ? "success" : "fail";
    quest.fail_count = res.fail_count;
    quest.team = team.slice();
    quest.leader = this.state.round.leader;
    this.state.mission.active = false;
    this.commit({
      type: "mission_result",
      quest_index: qi,
      team: team.slice(),
      success_count: res.success_count,
      fail_count: res.fail_count,
      passed: res.passed,
    });
    this.setPhase("mission_reveal");
  }

  private handleMissionReveal(): void {
    if (evilReachedQuestGoal(this.state.quests)) {
      this.endGame("evil", "邪恶方让 3 个任务失败,邪恶方获胜。");
      return;
    }
    if (goodReachedQuestGoal(this.state.quests)) {
      this.enterAssassinCouncil();
      return;
    }
    const round = this.state.round;
    round.quest_index += 1;
    round.proposal_attempt = 1;
    round.leader = nextLeader(round.leader, this.state.seat_order);
    this.commit({ type: "leader_changed", leader: round.leader });
    round.proposed_team = null;
    for (const p of SEAT_ORDER) {
      this.state.votes[p] = null;
      this.state.talk_stats[p].interrupts_in_round = 0;
    }
    this.enterProposalDiscussion();
  }

  /** Evil players openly confer about Merlin before the kill (2 round-robin rounds). */
  private enterAssassinCouncil(): void {
    const evil = SEAT_ORDER.filter((id) => this.state.players[id].alignment === "evil");
    const rounds = 2;
    const queue: PlayerId[] = [];
    for (let r = 0; r < rounds; r++) queue.push(...evil);
    this.state.round.normal_queue = queue;
    this.state.round.current_speaker = null;
    this.state.round.next_normal_speaker = queue[0] ?? null;
    this.setPhase("assassination_discuss");
  }

  private async handleAssassinationDiscuss(): Promise<void> {
    const round = this.state.round;
    if (round.normal_queue.length === 0) {
      round.current_speaker = null;
      this.setPhase("assassination");
      return;
    }
    const speaker = round.normal_queue[0]!;
    round.current_speaker = speaker;
    round.next_normal_speaker = round.normal_queue[1] ?? null;
    const assassin = this.findRoleSeat("Assassin");
    const canDecideNow =
      speaker === assassin && !round.normal_queue.slice(1).includes(assassin);
    const evilIdentity = this.evilIdentitySummaryForAssassination();

    const { action } = await this.ask(
      speaker,
      canDecideNow ? "assassination_decision" : "full_speech",
      canDecideNow
        ? "正义方已完成 3 个任务。邪恶方已讨论一轮,现在第二轮再次轮到你这名刺客。你可以继续公开商议,也可以直接刺杀。" +
          `\n${evilIdentity}`
        : "正义方已完成 3 个任务,进入刺杀环节。你们邪恶方现在公开商议谁是梅林——" +
          "说出你的判断和理由,并回应队友刚才的发言。最后将由刺客做出最终指认。" +
          `\n${evilIdentity}`,
      "medium",
    );
    if (this.state.status === "completed") return;
    if (action.action === "assassinate") {
      this.commitAssassination(assassin, action);
      return;
    }
    const speak = action as SpeakAction;
    this.commit({
      type: "public_speech",
      player: speaker,
      target: speak.target ?? null,
      speech: speak.speech,
      source: "normal",
    });
    round.normal_queue.shift();
    round.next_normal_speaker = round.normal_queue[0] ?? null;
  }

  private async handleAssassination(): Promise<void> {
    const assassin = this.findRoleSeat("Assassin");
    const { action } = await this.ask(
      assassin,
      "assassination",
      `结合刚才邪恶方的公开商议,作出你最终的梅林指认。\n${this.evilIdentitySummaryForAssassination()}`,
      "medium",
    );
    if (this.state.status === "completed") return;
    const a = action as Extract<PlayerAction, { action: "assassinate" }>;
    this.commitAssassination(assassin, a);
  }

  private commitAssassination(
    assassin: PlayerId,
    a: Extract<PlayerAction, { action: "assassinate" }>,
    options?: { early?: boolean },
  ): void {
    const targetWasMerlin = this.state.players[a.target].role === "Merlin";
    if (a.speech) {
      this.commit({
        type: "public_speech",
        player: assassin,
        target: a.target,
        speech: a.speech,
        source: "normal",
      });
    }
    this.commit({
      type: "assassination_attempt",
      assassin,
      target: a.target,
      target_was_merlin: targetWasMerlin,
    });
    if (targetWasMerlin) {
      this.endGame("evil", "刺客成功认出了梅林,邪恶方获胜。");
    } else {
      this.endGame(
        "good",
        options?.early
          ? "刺客错指,正义方获胜。"
          : "正义方完成 3 个任务,且刺客没能认出梅林,正义方获胜。",
      );
    }
  }

  private endGame(winner: "good" | "evil", reason: string): void {
    this.state.winner = winner;
    this.state.game_over_reason = reason;
    this.commit({ type: "game_over", winner, reason });
    this.setPhase("game_over");
    this.state.status = "completed";
    this.autoRun = false;
    this.notice({ kind: "game_over", winner, reason });
  }

  private findRoleSeat(role: Role): PlayerId {
    for (const p of SEAT_ORDER) if (this.state.players[p].role === role) return p;
    throw new Error(`role not present: ${role}`);
  }

  private evilIdentitySummaryForAssassination(): string {
    const identities = SEAT_ORDER
      .filter((id) => this.state.players[id].alignment === "evil")
      .map((id) => `${id}:${roleLabel(this.state.players[id].role)}`)
      .join("，");
    return (
      `【刺杀阶段秘密信息】邪恶方完整身份:${identities}。` +
      "此阶段所有邪恶方都已互相摊牌:奥伯伦现在知道刺客和莫甘娜是谁,刺客/莫甘娜现在也知道奥伯伦是谁。"
    );
  }

  // ----- UI status projection ----------------------------------------------

  private recomputeStatuses(): void {
    const s = this.state;
    for (const id of SEAT_ORDER) {
      s.players[id].status = this.statusFor(id);
    }
  }

  private statusFor(id: PlayerId): GameState["players"][PlayerId]["status"] {
    const s = this.state;
    const postgame = s.postgame_review;
    if (
      (postgame?.status === "running" || postgame?.status === "waiting_human") &&
      s.round.current_speaker === id
    ) {
      return "speaking";
    }
    if (s.status === "completed") return "idle";
    if (s.round.current_speaker === id) return "speaking";
    if (s.interrupts.directed_dialogue?.target === id) return "targeted";
    if (s.phase === "assassination" && s.players[id].role === "Assassin") return "assassinating";
    if (s.phase === "team_vote") return "voting";
    if (s.phase === "mission_action" && s.mission.team.includes(id)) return "on_mission";
    if (s.interrupts.queue.some((r) => r.player === id)) return "interrupt_queue";
    const cd = s.talk_stats[id].cooldown_until_event_index;
    if (cd !== null && publicSpeechCount(s) < cd) return "cooldown";
    if (s.round.leader === id) return "leader";
    return "idle";
  }

  // ----- export ------------------------------------------------------------

  export(): ExportBundle {
    return {
      game_id: this.state.game_id,
      config: this.state.config,
      final_state: this.state,
      event_log: this.state.event_log,
      public_event_log: this.getPublicView().public_event_log,
      result: { winner: this.state.winner, reason: this.state.game_over_reason },
      exported_at: Date.now(),
    };
  }
}
