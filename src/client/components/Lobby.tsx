import { useState } from "react";
import { api } from "../api";
import { content } from "../ctx";
import type { PageProps } from "../main";

export default function Lobby({ session, view, setView, meta, leave }: PageProps) {
  const [err, setErr] = useState("");
  const [bot, setBot] = useState("greedy");
  const isHost = view.hostId === view.me;
  const n = view.playerOrder.length;
  const op = async (body: Record<string, unknown>) => {
    setErr("");
    try { setView(await api.lobby(session, body)); } catch (e) { setErr((e as Error).message); }
  };
  const link = `${location.origin}/?room=${view.code}`;

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 34 }}>等待玩家</h1>
        <button className="btn ghost small" onClick={async () => { await api.lobby(session, { op: "leave" }).catch(() => {}); leave(); }}>離開房間</button>
      </div>
      <div className="row" style={{ gap: 20 }}>
        <span className="code-plate" aria-label="房間代碼">{view.code}</span>
        <div className="stack" style={{ gap: 6 }}>
          <span className="muted small">把代碼或連結給朋友</span>
          <button className="btn small" onClick={() => navigator.clipboard?.writeText(link)}>複製邀請連結</button>
        </div>
      </div>

      <section className="stack">
        <h2 style={{ fontSize: 22 }}>玩家（{n} / {content.rules.maxPlayers}）</h2>
        <ul className="players-list">
          {view.playerOrder.map((id) => {
            const p = view.players[id];
            return (
              <li key={id} className="player-chip">
                <span className="pen" style={{ background: p.color }} />
                <span style={{ flex: 1 }}>{p.name}{id === view.hostId && <span className="tag">房主</span>}{p.isBot && <span className="tag">AI</span>}{id === view.me && <span className="tag">你</span>}</span>
                {isHost && id !== view.me && <button className="btn ghost small" onClick={() => op({ op: "remove", playerId: id })} aria-label={`移除 ${p.name}`}>✕</button>}
              </li>
            );
          })}
        </ul>
        {isHost && n < content.rules.maxPlayers && (
          <div className="row">
            <select value={bot} onChange={(e) => setBot(e.target.value)} aria-label="AI 類型">
              {meta.bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button className="btn small" onClick={() => op({ op: "add_bot", strategy: bot })}>加入 AI 玩家</button>
          </div>
        )}
      </section>

      <section className="stack">
        <h2 style={{ fontSize: 22 }}>設定</h2>
        <div className="row">
          <span>回合數</span>
          {content.rules.roundOptions.map((r) => (
            <button key={r} className={`btn small ${view.settings.totalRounds === r ? "primary" : ""}`} disabled={!isHost} onClick={() => op({ op: "rounds", rounds: r })}>{r}</button>
          ))}
          <span className="muted small">（約每回合 5–8 分鐘）</span>
        </div>
        <div className="row">
          <span>每回合時限</span>
          {[120, 300, 600, 1200].map((s) => (
            <button key={s} className={`btn small ${view.settings.turnTimeoutSec === s ? "primary" : ""}`} disabled={!isHost} onClick={() => op({ op: "timeout", seconds: s })}>{s / 60} 分</button>
          ))}
          <span className="muted small">超時由 AI 代打，遊戲不會卡住</span>
        </div>
      </section>

      {err && <p className="error">{err}</p>}
      {isHost ? (
        <div className="row">
          <button className="btn primary" disabled={n < content.rules.minPlayers} onClick={() => op({ op: "start" })}>開始遊戲</button>
          {n < content.rules.minPlayers && <span className="muted small">至少 {content.rules.minPlayers} 人（可加入 AI）</span>}
        </div>
      ) : <p className="muted">等待房主開始…</p>}
    </div>
  );
}
