import { playerLabel, type PlayerId } from "@avalon/shared";

interface PlayerMindPanelProps {
  player: PlayerId;
  notes: string[];
  onClose: () => void;
}

export function PlayerMindPanel({ player, notes, onClose }: PlayerMindPanelProps) {
  return (
    <div className="mind-panel">
      <div className="mind-head">
        <strong>{playerLabel(player)} 的内心戏</strong>
        <button className="mind-close" onClick={onClose} type="button" title="关闭">
          x
        </button>
      </div>
      {notes.length === 0 ? (
        <div className="mind-empty">暂无内心戏</div>
      ) : (
        <ol className="mind-list">
          {notes.map((note, i) => (
            <li key={`${i}-${note}`}>{note}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
