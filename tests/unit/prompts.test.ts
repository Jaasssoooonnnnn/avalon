import { describe, expect, it } from "vitest";
import {
  PROMPT_ALLOWED_ACTIONS,
  SCHEMA_NAME_BY_PROMPT,
  SEAT_ORDER,
  type Alignment,
  type ModelCallInput,
  type PlayerId,
  type PrivatePlayerView,
  type PromptType,
  type PublicGameView,
  type Role,
} from "@avalon/shared";
import { buildPrompt } from "../../apps/server/src/models/prompts";

const ROLE_ALIGNMENT: Record<Role, Alignment> = {
  Merlin: "good",
  Percival: "good",
  "Loyal Servant": "good",
  Assassin: "evil",
  Morgana: "evil",
  Oberon: "evil",
};

function publicView(promptType: PromptType): PublicGameView {
  const phase =
    promptType === "postgame_review"
      ? "game_over"
      : promptType === "mission"
      ? "mission_action"
      : promptType === "vote"
        ? "team_vote"
        : promptType === "leader_discussion"
          ? "discussion"
          : "normal_speech";
  return {
    game_id: "prompt_test",
    status: promptType === "postgame_review" ? "completed" : "running",
    phase,
    quest_index: 0,
    leader: "A",
    current_speaker: null,
    next_normal_speaker: null,
    proposed_team: promptType === "leader_discussion" ? null : ["A", "B"],
    proposal_attempt: 1,
    consecutive_rejections: 0,
    players: SEAT_ORDER.map((id) => ({
      id,
      display_name: `玩家${id}`,
      model: "gpt-5.5",
      status: "idle",
      is_leader: id === "A",
      is_current_speaker: false,
      is_on_proposed_team: id === "A" || id === "B",
      is_targeted: false,
      has_pending_interrupt: false,
      in_cooldown: false,
      last_vote: null,
    })),
    seat_order: SEAT_ORDER.slice(),
    quest_history: [
      { index: 0, required_players: 2, fail_cards_required: 1, result: null, fail_count: null, team: null, leader: null },
      { index: 1, required_players: 3, fail_cards_required: 1, result: null, fail_count: null, team: null, leader: null },
      { index: 2, required_players: 3, fail_cards_required: 1, result: null, fail_count: null, team: null, leader: null },
      { index: 3, required_players: 4, fail_cards_required: 2, result: null, fail_count: null, team: null, leader: null },
      { index: 4, required_players: 4, fail_cards_required: 1, result: null, fail_count: null, team: null, leader: null },
    ],
    public_event_log: [],
    pending_interrupts: 0,
    human_seat: null,
    pending_human: null,
    winner: promptType === "postgame_review" ? "good" : null,
    game_over_reason: promptType === "postgame_review" ? "测试结束。" : null,
    postgame_review: {
      status: promptType === "postgame_review" ? "running" : "not_started",
      next_player: promptType === "postgame_review" ? "A" : null,
      completed_players: [],
    },
    revealed_identities:
      promptType === "postgame_review"
        ? {
            A: { role: "Merlin", alignment: "good" },
            B: { role: "Percival", alignment: "good" },
            C: { role: "Loyal Servant", alignment: "good" },
            D: { role: "Loyal Servant", alignment: "good" },
            E: { role: "Assassin", alignment: "evil" },
            F: { role: "Morgana", alignment: "evil" },
            G: { role: "Oberon", alignment: "evil" },
          }
        : null,
  };
}

function privateView(role: Role): PrivatePlayerView {
  const alignment = ROLE_ALIGNMENT[role];
  const view: PrivatePlayerView = {
    you: "A",
    role,
    alignment,
    model: "gpt-5.5",
    strategic_reminder: "测试提醒。",
    notes: [],
  };
  if (role === "Merlin") view.known_evil_players = ["C", "D", "E"];
  if (role === "Percival") view.merlin_candidates = ["A", "B"];
  if (role === "Assassin") view.evil_team = ["A", "B"];
  if (role === "Morgana") view.evil_team = ["A", "B"];
  if (role === "Oberon") view.evil_team = ["A"];
  return view;
}

function input(role: Role, promptType: PromptType): ModelCallInput {
  return {
    player_id: "A" as PlayerId,
    model: "gpt-5.5",
    phase: publicView(promptType).phase,
    prompt_type: promptType,
    private_view: privateView(role),
    public_view: publicView(promptType),
    legal_actions: PROMPT_ALLOWED_ACTIONS[promptType],
    schema_name: SCHEMA_NAME_BY_PROMPT[promptType],
  };
}

describe("strategy guide prompt injection", () => {
  it("injects common (alignment-neutral) strategy for every role", () => {
    for (const role of Object.keys(ROLE_ALIGNMENT) as Role[]) {
      const built = buildPrompt(input(role, "full_speech"));
      expect(built.system).toContain("=== 通用阿瓦隆策略(当前 7 人局) ===");
      expect(built.system).toContain("队长带自己是常规操作");
      expect(built.system).toContain("内白");
      expect(built.system).toContain("外白");
      expect(built.system).toContain("反复被不同队长选择的人是叠票位");
      expect(built.system).toContain("开局零信息不要点名别人定车");
      expect(built.system).toContain("新队长在定车前先复盘上一轮公开信息");
      expect(built.system).toContain("投票前先想两种结果");
      expect(built.system).toContain("任何玩家都可以跳派、装派或做挡刀");
      expect(built.system).toContain("任何玩家都可以策略性地装派西维尔");
      expect(built.system).toContain("公开身份声明是游戏内策略");
      expect(built.system).toContain("派西维尔在关键轮可以明确跳派给队形");
      expect(built.system).not.toContain("不要说出自己真实的角色或阵营");
    }
  });

  it("injects good-side common strategy only for good roles", () => {
    const goodRoles: Role[] = ["Merlin", "Percival", "Loyal Servant"];
    const evilRoles: Role[] = ["Assassin", "Morgana", "Oberon"];
    for (const role of goodRoles) {
      const sys = buildPrompt(input(role, "full_speech")).system;
      expect(sys).toContain("=== 正义方公共策略 ===");
      expect(sys).toContain("胜利优先于验人");
      expect(sys).toContain("派西维尔或身份位有没有队形意见");
      expect(sys).toContain("问车队建议时优先问派西维尔");
      // #2 fix: match point is "whoever reaches 2", not a literal scoreline —
      // 2-1 / 1-2 must count, carried by the (2-0 或 2-1)/(0-2 或 1-2) parentheticals.
      expect(sys).toContain("好人已拿 2 个成功(2-0 或 2-1)");
      expect(sys).toContain("邪恶方已让 2 个任务失败(0-2 或 1-2)");
      // 2-2 is the decider (Q5 win-or-lose for both) — must be in the definition too.
      expect(sys).toContain("2-2 是决胜局");
      expect(sys).toContain("逆风赛点应直接跳派带队");
      expect(sys).not.toContain("=== 邪恶方公共策略 ===");
    }
    for (const role of evilRoles) {
      const sys = buildPrompt(input(role, "full_speech")).system;
      expect(sys).not.toContain("=== 正义方公共策略 ===");
      // Good-side win plan must NOT leak into evil prompts.
      expect(sys).not.toContain("胜利优先于验人");
      expect(sys).not.toContain("问车队建议时优先问派西维尔");
    }
  });

  it("injects evil-side common strategy only for evil roles", () => {
    const goodRoles: Role[] = ["Merlin", "Percival", "Loyal Servant"];
    const evilRoles: Role[] = ["Assassin", "Morgana", "Oberon"];
    for (const role of evilRoles) {
      const sys = buildPrompt(input(role, "full_speech")).system;
      expect(sys).toContain("=== 邪恶方公共策略 ===");
      expect(sys).toContain("阻止正义方完成第 3 个成功任务");
      // #2 counterpart: evil disrupts the match-point "谁是派" moment.
      expect(sys).toContain("这正是你搅局的窗口");
      expect(sys).toContain("公开发言绝不能暴露邪恶方胜负视角");
      expect(sys).toContain("不要说“保送好人/送好人赢/不能让好人三蓝");
      expect(sys).toContain("成功位可能藏牌");
      // Match point is "whoever reaches 2": 2-1/1-2 count, not just 2-0/0-2.
      expect(sys).toContain("0-2/1-2");
      // 2-2 decider belongs in the evil disruption window too.
      expect(sys).toContain("2-2 决胜局");
      expect(sys).not.toContain("=== 正义方公共策略 ===");
    }
    for (const role of goodRoles) {
      const sys = buildPrompt(input(role, "full_speech")).system;
      expect(sys).not.toContain("=== 邪恶方公共策略 ===");
      expect(sys).not.toContain("这正是你搅局的窗口");
    }
  });

  it("injects only the current role strategy", () => {
    const merlin = buildPrompt(input("Merlin", "full_speech")).system;
    expect(merlin).toContain("=== 你的角色策略:梅林 ===");
    expect(merlin).toContain("第一目标是不被刺客识别;第二目标才是在不暴露的前提下帮助好人完成任务");
    expect(merlin).toContain("前两轮或零公开信息");
    expect(merlin).toContain("第一个/唯一一个无法用公开事实解释的反对票或强方向源");
    expect(merlin).toContain("先活过刺杀识别");
    expect(merlin).not.toContain("先让好人完成任务,再尽量躲刺");
    expect(merlin).toContain("不要连续只盯明红");
    expect(merlin).toContain("不要成为唯一方向源");
    expect(merlin).toContain("你的表水对象是全体好人");
    expect(merlin).toContain("学会“信任”坏人的一部分公开逻辑");
    expect(merlin).toContain("当普通好人踩中邪恶方时");
    expect(merlin).toContain("若邪恶方发出看似干净但实际有明红的试探车");
    expect(merlin).toContain("明红进车不等于必须立刻公开强反");
    expect(merlin).toContain("不要只因为你知道某人是红就抢话单点他");
    // Merlin must not reject an early all-evil team on night vision (open-eye tell).
    expect(merlin).toContain("招来刺杀的头号 tell");
    expect(merlin).not.toContain("=== 你的角色策略:派西维尔 ===");
    expect(merlin).not.toContain("=== 你的角色策略:莫甘娜 ===");

    const percival = buildPrompt(input("Percival", "full_speech")).system;
    expect(percival).toContain("=== 你的角色策略:派西维尔 ===");
    expect(percival).toContain("派视角的“双拇指”");
    expect(percival).toContain("如果你主动起跳派西维尔");
    expect(percival).toContain("不要在语言或队伍替换里暴露双拇指区间");
    expect(percival).toContain("若双拇指中的某一人先跳派或跳身份,不要立刻跟跳");
    expect(percival).toContain("若非双拇指的人跳派");
    expect(percival).toContain("不要让假身份位单方面带走队形");
    expect(percival).toContain("明跳派西维尔是合格操作");
    expect(percival).toContain("我跳派");
    expect(percival).toContain("这车我要上");
    expect(percival).toContain("不要只在 memo 里想上车");
    expect(percival).toContain("二人失败车");
    expect(percival).toContain("你的第一优先级是推动原车复跑拿第三蓝");
    expect(percival).toContain("如果多数人仍跑偏,可以跳派来给队形");
    expect(percival).toContain("你不能只在 memo 里保护梅林");
    expect(percival).toContain("两名梅林候选的发车和投票都是高信息源");
    expect(percival).toContain("真梅林激进时你要更像保守身份牌");

    const morgana = buildPrompt(input("Morgana", "full_speech")).system;
    expect(morgana).toContain("=== 你的角色策略:莫甘娜 ===");
    expect(morgana).toContain("任务牌责任顺序是:奥伯伦先负责,其次刺客,最后莫甘娜");
    expect(morgana).toContain("刺客这个已知队友同车并会负责失败");
    expect(morgana).toContain("不要因为“可能有奥伯伦在车上”就藏牌白送任务");
    expect(morgana).not.toContain("已知邪恶方(奥伯伦/刺客)");
    expect(morgana).toContain("可以发一个看似干净或疑似好人的队伍");
    expect(morgana).toContain("必要时可以装派或制造身份压力");
    expect(morgana).toContain("自己装派给队形");
    expect(morgana).not.toContain("=== 你的角色策略:梅林 ===");
    expect(morgana).not.toContain("=== 你的角色策略:派西维尔 ===");
  });

  it("keeps Oberon isolated and does not tell Assassin/Morgana who Oberon is", () => {
    const oberon = buildPrompt(input("Oberon", "mission")).system;
    expect(oberon).toContain("你是邪恶方奥伯伦");
    expect(oberon).toContain("你不知道刺客和莫甘娜是谁");

    const assassin = buildPrompt(input("Assassin", "full_speech")).system;
    expect(assassin).toContain("你不知道他是谁");
    expect(assassin).not.toContain("奥伯伦是玩家");

    const morgana = buildPrompt(input("Morgana", "full_speech")).system;
    expect(morgana).toContain("你不知道他是谁");
    expect(morgana).not.toContain("奥伯伦是玩家");
  });

  it("filters out expansion-rule concepts from the strategy guide", () => {
    const system = buildPrompt(input("Loyal Servant", "full_speech")).system;
    const guide = system.slice(system.indexOf("=== 通用阿瓦隆策略"));
    expect(guide).not.toContain("湖中女神");
    expect(guide).not.toContain("莫德雷德");
    expect(guide).not.toContain("隐狼");
    expect(guide).not.toContain("兰斯洛特");
    expect(guide).not.toContain("8-10");
  });

  it("adds stage-specific strategy corrections", () => {
    const speech = buildPrompt(input("Loyal Servant", "full_speech")).dynamic_user;
    expect(speech).toContain("队长带自己是阿瓦隆常规操作");
    expect(speech).toContain("不能单独作为怀疑点");
    expect(speech).toContain("发言要给出一点可复核支撑");
    expect(speech).toContain("二人失败车");
    expect(speech).toContain("必须正面回应");
    expect(speech).toContain("桌面通常会先讨论能否直接拿第三蓝");
    expect(speech).toContain("原车复跑可以直接赢任务");
    expect(speech).toContain("反对它时也必须给普通玩家能接受的公开理由");
    expect(speech).toContain("不要把自己的私有阵营目标摊开");
    expect(speech).toContain("谁是派");
    expect(speech).toContain("优先问派西维尔/身份位给安全队形");
    expect(speech).toContain("任何玩家都可以跳派、装派或假装身份位");
    expect(speech).toContain("不要逼人报双拇指或梅林候选");
    expect(speech).toContain("开局零信息时不要点名别人定车");
    expect(speech).toContain("点名别人给队形应留给已有公开矛盾");
    expect(speech).not.toContain("你的真实判断来自私有信息");
    expect(speech).not.toContain("不要只因为你知道某人是红");

    const leaderDiscussion = buildPrompt(input("Loyal Servant", "leader_discussion")).dynamic_user;
    expect(leaderDiscussion).toContain("先发言:用 `speak`");
    expect(leaderDiscussion).toContain("正式发车");
    expect(leaderDiscussion).toContain("第一轮第一个发言");
    expect(leaderDiscussion).toContain("不要点名别人定车");
    expect(leaderDiscussion).toContain("开局队长通常应自己给一个可负责的基准");
    expect(leaderDiscussion).toContain("确认车队前最先讨论上一轮信息");
    expect(leaderDiscussion).toContain("尤其上一轮任务失败时");
    expect(leaderDiscussion).toContain("谁是派");
    expect(leaderDiscussion).toContain("最稳的公开问法是先问派西维尔/身份位");
    expect(leaderDiscussion).toContain("派西维尔或身份位有没有队形意见");
    expect(leaderDiscussion).toContain("点名别人给队形只适合已有公开矛盾");
    expect(leaderDiscussion).toContain("任何人都可能装派");
    expect(leaderDiscussion).toContain("不要要求报双拇指或梅林候选");
    expect(leaderDiscussion).toContain("propose_team");

    const interrupt = buildPrompt(input("Merlin", "interrupt_intent")).dynamic_user;
    expect(interrupt).toContain("二人失败车");
    expect(interrupt).toContain("通常应该抢话");
    expect(interrupt).toContain("不要说“我的私有信息显示”");
    expect(interrupt).not.toContain("私有信息显示某人有问题");
    expect(interrupt).not.toContain("多个车外未验证位里选了谁");

    const leader = buildPrompt(input("Loyal Servant", "leader_proposal")).dynamic_user;
    expect(leader).toContain("自己 + 前面反复出现的叠票位");
    expect(leader).toContain("非常规试探车可以观察外白/内反");
    expect(leader).toContain("若上一轮成功队伍人数正好等于当前任务人数");
    expect(leader).toContain("放弃直接胜利机会");

    const vote = buildPrompt(input("Loyal Servant", "vote")).dynamic_user;
    expect(vote).toContain("投票前做一次票型模拟");
    expect(vote).toContain("这车是否放弃了可直接三蓝的原车");
    expect(vote).toContain("老带新/继续验身份");
    // Round-1 zero-info teams should default to approve, not a silent reject.
    expect(vote).toContain("默认应赞成");

    const mission = buildPrompt(input("Oberon", "mission")).dynamic_user;
    expect(mission).toContain("任务 4 需要 2 张失败牌");
    expect(mission).toContain("正义方");
    expect(mission).toContain("按你的私有身份策略判断");
    // Leak guard: the shared mission prompt must NOT spell out the evil
    // fail-coordination playbook — that lives in the evil role guides only.
    expect(mission).not.toContain("失败牌责任顺序");
    expect(mission).not.toContain("莫甘娜赞成时藏一轮可混淆派西维尔");
    // Evil still receives the coordination via their (alignment-gated) role guide.
    expect(buildPrompt(input("Morgana", "mission")).system).toContain(
      "任务牌责任顺序是:奥伯伦先负责,其次刺客,最后莫甘娜",
    );

    const assassination = buildPrompt(input("Assassin", "assassination")).dynamic_user;
    expect(assassination).not.toContain("先拆分身份");
  });

  it("builds a post-game review prompt with revealed identities and no in-game continuation", () => {
    const built = buildPrompt(input("Merlin", "postgame_review"));
    expect(built.dynamic_user).toContain("请求类型:postgame_review");
    expect(built.dynamic_user).toContain("本次唯一允许动作:speak");
    expect(built.dynamic_user).toContain("赛后复盘");
    expect(built.dynamic_user).toContain("所有玩家的真实身份和阵营已经公开");
    expect(built.dynamic_user).toContain("不要继续假装不知道身份");
    expect(built.dynamic_user).toContain("梅林-正义方");
    expect(built.dynamic_user).toContain("刺客-邪恶方");
  });

  it("keeps shared public-stage prompts free of alignment-branch tactics", () => {
    const speech = buildPrompt(input("Loyal Servant", "full_speech")).dynamic_user;
    expect(speech).not.toContain("好人应");
    expect(speech).not.toContain("正义方已经");
    // Shared prompt: must not instruct the real Percival to claim (a good-only tactic).
    expect(speech).not.toContain("如果你就是派西维尔");

    const leader = buildPrompt(input("Loyal Servant", "leader_proposal")).dynamic_user;
    expect(leader).not.toContain("好人视角");
    expect(leader).not.toContain("常规好人车");
    expect(leader).not.toContain("邪恶方可以");
    expect(leader).not.toContain("正义方队长");
    expect(leader).not.toContain("邪恶方队长");

    const leaderDiscussion = buildPrompt(input("Loyal Servant", "leader_discussion")).dynamic_user;
    expect(leaderDiscussion).not.toContain("好人应");
    expect(leaderDiscussion).not.toContain("邪恶方可以");
    expect(leaderDiscussion).not.toContain("正义方已经");

    const vote = buildPrompt(input("Loyal Servant", "vote")).dynamic_user;
    expect(vote).not.toContain("好人对");
    expect(vote).not.toContain("邪恶方可以");
    expect(vote).not.toContain("正义方已经");
    // Shared prompt: must not coach Merlin/Percival on vote-tells (good-only).
    expect(vote).not.toContain("梅林不要连续投出");
  });
});
