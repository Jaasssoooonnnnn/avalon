/**
 * Role assignment + private-view computation. Enforces the identity-information
 * rules: Merlin sees evil, Percival sees Merlin+Morgana (shuffled),
 * Assassin/Morgana see each other, Oberon sees no evil teammates, Loyal
 * Servants see nothing.
 */

import {
  PLAYER_IDS,
  ROLE_ALIGNMENT,
  ROLE_BAG,
  type Alignment,
  type ModelName,
  type PlayerId,
  type PrivatePlayerView,
  type Role,
} from "@avalon/shared";
import { shuffle, type Rng } from "../utils/random.js";

export interface RoleAssignment {
  role: Role;
  alignment: Alignment;
}

const MAX_ROLE_DEAL_ATTEMPTS = 1000;

function hasThreeConsecutiveEvilSeats(dealt: readonly Role[]): boolean {
  const evilIndexes = new Set<number>();
  dealt.forEach((role, index) => {
    if (ROLE_ALIGNMENT[role] === "evil") evilIndexes.add(index);
  });

  for (let i = 0; i < PLAYER_IDS.length; i++) {
    if (
      evilIndexes.has(i) &&
      evilIndexes.has((i + 1) % PLAYER_IDS.length) &&
      evilIndexes.has((i + 2) % PLAYER_IDS.length)
    ) {
      return true;
    }
  }
  return false;
}

function rolesToAssignments(dealt: readonly Role[]): Record<PlayerId, RoleAssignment> {
  const out = {} as Record<PlayerId, RoleAssignment>;
  PLAYER_IDS.forEach((id, i) => {
    const role = dealt[i]!;
    out[id] = { role, alignment: ROLE_ALIGNMENT[role] };
  });
  return out;
}

/** Randomly deal the 7-role bag (4 good + 3 evil) to the seats. */
export function assignRoles(rng: Rng): Record<PlayerId, RoleAssignment> {
  for (let attempt = 0; attempt < MAX_ROLE_DEAL_ATTEMPTS; attempt++) {
    const dealt = shuffle(ROLE_BAG, rng);
    if (!hasThreeConsecutiveEvilSeats(dealt)) {
      return rolesToAssignments(dealt);
    }
  }
  throw new Error("failed to deal roles without three consecutive evil seats");
}

export function findRole(
  roles: Record<PlayerId, RoleAssignment>,
  role: Role,
): PlayerId {
  for (const id of PLAYER_IDS) {
    if (roles[id].role === role) return id;
  }
  throw new Error(`role not assigned: ${role}`);
}

export function evilPlayers(roles: Record<PlayerId, RoleAssignment>): PlayerId[] {
  return PLAYER_IDS.filter((id) => roles[id].alignment === "evil");
}

const STRATEGIC_REMINDER: Record<Role, string> = {
  Merlin:
    "你暗中知道谁是邪恶方,但绝不能表现得太明显——如果正义方赢了却被刺客认出你,胜利会被邪恶方夺走。" +
    "要不动声色地把正义方引向安全的队伍,绝不要公开点出邪恶玩家。",
  Percival:
    "你看到两名「梅林候选人」,但分不清谁是真梅林(另一个是邪恶的莫甘娜)。" +
    "保护真正的梅林,并从他们的行为中判断哪一个才是真的。",
  "Loyal Servant":
    "你没有任何特殊信息。通过发车、投票和任务结果来推理谁是邪恶方,帮助正义方完成 3 个任务。",
  Assassin:
    "你是邪恶方并且认识你的队友。帮助让任务失败,同时留意梅林——如果正义方完成 3 个任务," +
    "你有一次刺杀梅林反败为胜的机会。注意谁好像知道得太多。",
  Morgana:
    "你是邪恶方,而且在派西维尔眼里你是「梅林候选人」之一。利用这一点:" +
    "装成可信的好人,甚至声称自己是梅林/派西维尔来制造混乱。",
  Oberon:
    "你是邪恶方奥伯伦,但你是孤狼:你不知道刺客和莫甘娜是谁,他们也不知道你是谁。" +
    "混进好人之中,设法进入任务队伍,在不引起怀疑的情况下让任务失败。",
};

/**
 * Build the static private view for one player. This contains identity info only;
 * dynamic public game state is delivered separately via PublicGameView.
 */
export function buildPrivateView(
  playerId: PlayerId,
  model: ModelName,
  roles: Record<PlayerId, RoleAssignment>,
  rng: Rng,
): PrivatePlayerView {
  const { role, alignment } = roles[playerId];
  const view: PrivatePlayerView = {
    you: playerId,
    role,
    alignment,
    model,
    strategic_reminder: STRATEGIC_REMINDER[role],
    notes: [],
  };

  const evil = evilPlayers(roles);

  if (role === "Merlin") {
    // Merlin sees the evil players (as "known evil", not exact roles).
    view.known_evil_players = evil.slice();
  } else if (role === "Percival") {
    // Percival sees the true Merlin and Morgana, shuffled.
    const merlin = findRole(roles, "Merlin");
    const morgana = findRole(roles, "Morgana");
    view.merlin_candidates = shuffle([merlin, morgana], rng);
  } else if (alignment === "evil") {
    // Oberon is isolated: they see no teammates, and other evil players do not
    // see Oberon. Keep self in the list so downstream logic can still treat
    // the known evil set as "evil players this player knows".
    if (role === "Oberon") {
      view.evil_team = [playerId];
    } else {
      view.evil_team = evil.filter((id) => roles[id].role !== "Oberon");
    }
  }

  return view;
}
