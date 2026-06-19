import { useEffect, useState } from "react";
import {
  DEFAULT_SEATS,
  INTERRUPT_WINDOW_MS_DEFAULT,
  INTERRUPT_WINDOW_MS_MAX,
  INTERRUPT_WINDOW_MS_MIN,
  MODEL_POOL,
  SEAT_ORDER,
  seatDisplayName,
  type GameConfig,
  type GameSummary,
  type ModelInfo,
  type ModelName,
  type PlayerId,
} from "@avalon/shared";
import { api } from "../lib/api";

interface SetupProps {
  onCreate: (config: Partial<GameConfig>) => void;
  onLoad: (gameId: string) => void;
  error: string | null;
  connecting: boolean;
}

function gameStatusText(g: GameSummary): string {
  if (g.status === "completed") return g.winner === "good" ? "正义方胜" : g.winner === "evil" ? "邪恶方胜" : "已结束";
  if (g.status === "running") return "进行中";
  if (g.status === "paused") return "已暂停";
  return "未开始";
}

export function Setup({ onCreate, onLoad, error, connecting }: SetupProps) {
  const [models, setModels] = useState<ModelInfo[]>([...MODEL_POOL]);
  const [seats, setSeats] = useState<Record<PlayerId, ModelName>>({ ...DEFAULT_SEATS });
  const [randomizeSeats, setRandomizeSeats] = useState(false);
  const [mock, setMock] = useState(true);
  const [windowMs, setWindowMs] = useState(INTERRUPT_WINDOW_MS_DEFAULT);
  const [evilFail, setEvilFail] = useState(0.7);
  const [seed, setSeed] = useState<string>("");
  const [games, setGames] = useState<GameSummary[]>([]);
  const [humanPlay, setHumanPlay] = useState(false);
  const [humanSeat, setHumanSeat] = useState<PlayerId>("A");

  useEffect(() => {
    api.listModels().then((r) => setModels(r.models)).catch(() => undefined);
  }, []);

  const refreshGames = () => {
    api.listGames().then((r) => setGames(r.games)).catch(() => undefined);
  };
  useEffect(refreshGames, []);

  const removeGame = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.deleteGame(id);
      setGames((gs) => gs.filter((g) => g.game_id !== id));
    } catch {
      /* ignore */
    }
  };

  const submit = () => {
    const config: Partial<GameConfig> = {
      seats,
      randomize_seats: randomizeSeats,
      mock,
      interrupt_window_ms: windowMs,
      evil_fail_probability: evilFail,
      seed: seed.trim() === "" ? null : Number(seed),
      human_seat: humanPlay ? humanSeat : null,
    };
    onCreate(config);
  };

  const randomizeModels = () => {
    const names = models.map((m) => m.name);
    const next = {} as Record<PlayerId, ModelName>;
    for (const s of SEAT_ORDER) next[s] = names[Math.floor(Math.random() * names.length)]!;
    setSeats(next);
  };

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>
          Avalon <span className="accent">AI 竞技场</span>
        </h1>
        <p className="subtitle">
          7 个 AI 模型对弈《抵抗组织:阿瓦隆》。你负责观战、控制节奏,并(在上帝模式下)看到一切。
          为每个座位分配一个模型——角色会在开局时秘密发牌。
        </p>

        <div className="seat-grid">
          {SEAT_ORDER.map((id) => (
            <div className="seat-config" key={id}>
              <label>{seatDisplayName(id)}</label>
              <select
                value={seats[id]}
                onChange={(e) =>
                  setSeats((prev) => ({ ...prev, [id]: e.target.value as ModelName }))
                }
              >
                {models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div className="setup-actions-row">
          <button className="ghost" onClick={randomizeModels} type="button">
            🎲 随机模型
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={randomizeSeats}
              onChange={(e) => setRandomizeSeats(e.target.checked)}
            />
            开局随机打乱「模型 ↔ 座位」
          </label>
        </div>

        <div className="options">
          <label className="check big">
            <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} />
            <span>
              <strong>Mock 模式</strong>(不调用 API——即时、可复现、免费)
            </span>
          </label>

          <div className="option-row">
            <label>插话收集等待:{(windowMs / 1000).toFixed(1)} 秒(等各模型答"是否插话";真实模型需要几秒)</label>
            <input
              type="range"
              min={INTERRUPT_WINDOW_MS_MIN}
              max={INTERRUPT_WINDOW_MS_MAX}
              step={500}
              value={windowMs}
              onChange={(e) => setWindowMs(Number(e.target.value))}
            />
          </div>

          <div className="option-row">
            <label>邪恶方失败概率(Mock):{evilFail.toFixed(2)}</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={evilFail}
              onChange={(e) => setEvilFail(Number(e.target.value))}
            />
          </div>

          <div className="option-row">
            <label>随机种子(可选,用于复现对局)</label>
            <input
              type="number"
              placeholder="随机"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
            />
          </div>

          <label className="check big">
            <input type="checkbox" checked={humanPlay} onChange={(e) => setHumanPlay(e.target.checked)} />
            <span>
              <strong>我来当一名玩家</strong>(其余 6 个座位为 AI;你拥有最高抢话优先权)
            </span>
          </label>
          {humanPlay && (
            <div className="option-row">
              <label>你的座位</label>
              <select value={humanSeat} onChange={(e) => setHumanSeat(e.target.value as PlayerId)}>
                {SEAT_ORDER.map((id) => (
                  <option key={id} value={id}>
                    {seatDisplayName(id)}({seats[id]} 将由你接管)
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {error && <div className="error">{error}</div>}

        <button className="primary big" onClick={submit} disabled={connecting} type="button">
          {connecting ? "连接中…" : "创建对局"}
        </button>

        {games.length > 0 && (
          <div className="history">
            <div className="history-head">
              <span>历史对局({games.length})</span>
              <button className="ghost small" onClick={refreshGames} type="button">刷新</button>
            </div>
            <div className="history-list">
              {games.map((g) => (
                <div
                  key={g.game_id}
                  className="history-row"
                  onClick={() => onLoad(g.game_id)}
                  title="点击加载查看 / 复盘"
                >
                  <span className={`hist-badge ${g.status === "completed" ? (g.winner ?? "") : "wip"}`}>
                    {gameStatusText(g)}
                  </span>
                  <span className="hist-models">
                    {SEAT_ORDER.map((id) => g.models[id]).join(" · ")}
                  </span>
                  <span className="hist-meta">
                    {g.mock ? "Mock" : "真实"} · {g.num_events} 事件 ·{" "}
                    {new Date(g.created_at).toLocaleString()}
                  </span>
                  <button className="hist-del" onClick={(e) => removeGame(g.game_id, e)} type="button" title="删除">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
