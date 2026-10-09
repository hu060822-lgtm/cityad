import { useEffect, useState } from "react";
import { recordGame } from "../archive";
import { content, poiName } from "../ctx";
import type { PageProps } from "../main";
import type { ScoreBreakdown } from "../../shared/types";

const COLS: [keyof ScoreBreakdown, string][] = [
  ["assets", "資產"], ["influence", "影響力"], ["control", "控制"], ["exploration", "探索"], ["synergy", "組合"],
  ["dominance", "主導"], ["cityGoal", "城市目標"], ["crisis", "危機"], ["objectives", "秘密目標"], ["abilities", "能力"], ["total", "總分"],
];

export default function Results({ view, leave }: PageProps) {
  const r = view.result!;
  const [copied, setCopied] = useState(false);
  useEffect(() => { recordGame(view, poiName); }, [view]);
  const winners = r.winners.map((id) => view.players[id]?.name).join("、");

  const shareText = [
    `《CITY 台中》本局城市紀錄`,
    r.report.headline,
    ...r.report.playerLines.map((l) => `${view.players[l.playerId]?.name}｜${l.title}：${l.line}`),
    ...r.report.districtLines.map((l) => `${content.districtById[l.districtId]?.name}：${l.line}`),
  ].join("\n");

  return (
    <div className="page">
      <div>
        <p className="muted">第 {view.settings.totalRounds} 回合結束・勝者 {winners}</p>
        <h1 className="results-head">{r.report.headline}</h1>
      </div>

      <div className="report">
        <h3>本局台中</h3>
        <ul className="list">
          {r.report.playerLines.map((l) => {
            const p = view.players[l.playerId];
            return <li key={l.playerId}><span style={{ color: p?.color }}>●</span> <b>{p?.name}</b>・{l.title}<br /><span className="small">{l.line}</span></li>;
          })}
        </ul>
        <ul className="list small">
          {r.report.districtLines.map((l) => <li key={l.districtId}><span style={{ color: content.districtById[l.districtId]?.color }}>■</span> {content.districtById[l.districtId]?.name}：{l.line}</li>)}
        </ul>
        {r.report.highlights.length > 0 && <ul className="list small">{r.report.highlights.map((h, i) => <li key={i}><b>{h.label}</b>　{h.text}</li>)}</ul>}
        {r.report.achievements.length > 0 && <p className="small">成就：{r.report.achievements.map((a) => `${view.players[a.playerId]?.name}「${a.name}」`).join("、")}</p>}
        <div className="row"><button className="btn small" onClick={() => { navigator.clipboard?.writeText(shareText); setCopied(true); }}>{copied ? "已複製" : "複製城市紀錄"}</button></div>
      </div>

      <section style={{ overflowX: "auto" }}>
        <table className="score-table">
          <thead><tr><th>玩家</th>{COLS.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
          <tbody>
            {r.ranking.map((id) => {
              const s = r.scores[id];
              return <tr key={id} className={r.winners.includes(id) ? "win" : ""}><td><span style={{ color: view.players[id]?.color }}>●</span> {view.players[id]?.name}</td>{COLS.map(([k]) => <td key={k}>{s[k] as number}</td>)}</tr>;
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2 style={{ fontSize: 22 }}>揭曉：秘密目標</h2>
        <ul className="list">
          {r.ranking.map((id) => (
            <li key={id}><b>{view.players[id]?.name}</b>：{view.players[id]?.objectives.map((o) => {
              const done = r.scores[id].completedObjectives.includes(o);
              return <span key={o} className={done ? "done" : "muted"} style={{ marginRight: 10 }}>{content.objectiveById[o]?.name}（{content.objectiveById[o]?.vp}）</span>;
            })}</li>
          ))}
        </ul>
      </section>

      <div className="row"><button className="btn primary" onClick={leave}>回到首頁・再來一局</button></div>
    </div>
  );
}
