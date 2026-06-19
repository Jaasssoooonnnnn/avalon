import { roleLabel, type PrivatePlayerView } from "@avalon/shared";

interface YourIdentityProps {
  view: PrivatePlayerView;
}

/** Persistent card showing the human's OWN role + secret knowledge so they can play. */
export function YourIdentity({ view }: YourIdentityProps) {
  const evil = view.alignment === "evil";
  let secret: string | null = null;
  if (view.role === "Merlin" && view.known_evil_players) {
    secret = `你看到的邪恶方:${view.known_evil_players.map((id) => "玩家" + id).join("、")}(别表现得太明显!)`;
  } else if (view.role === "Percival" && view.merlin_candidates) {
    secret = `梅林候选人:${view.merlin_candidates.map((id) => "玩家" + id).join(" / ")}(一真一假)`;
  } else if (view.role === "Oberon") {
    secret = "你是奥伯伦:你不知道其他邪恶方,他们也不知道你。";
  } else if (evil && view.evil_team) {
    const mates = view.evil_team.filter((id) => id !== view.you);
    secret = `你已知的邪恶队友:${mates.length ? mates.map((id) => "玩家" + id).join("、") : "(无)"}`;
  } else {
    secret = "你没有特殊信息,靠推理找出邪恶方。";
  }

  return (
    <div className={`identity-card ${view.alignment}`}>
      <div className="id-head">
        你的身份 · <strong>{roleLabel(view.role)}</strong>
        <span className={`id-align ${view.alignment}`}>{evil ? "邪恶方" : "正义方"}</span>
      </div>
      <div className="id-secret">{secret}</div>
      <div className="id-hint">{view.strategic_reminder}</div>
    </div>
  );
}
