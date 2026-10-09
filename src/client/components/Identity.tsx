import { useState } from "react";
import { api } from "../api";
import { content, fmtRes, IDENTITY_COLOR } from "../ctx";
import type { PageProps } from "../main";

export default function Identity({ session, view, setView }: PageProps) {
  const me = view.me ? view.players[view.me] : null;
  const [dirs, setDirs] = useState<string[]>([]);
  const [ability, setAbility] = useState("");
  const [objs, setObjs] = useState<string[]>([]);
  const [start, setStart] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const hubs = content.pois.filter((p) => p.tags.includes("hub"));

  if (!me) return null;
  if (me.identityDone) {
    return (
      <div className="page">
        <h1 style={{ fontSize: 34 }}>等其他人決定自己是誰</h1>
        <ul className="players-list">
          {view.playerOrder.map((id) => {
            const p = view.players[id];
            return <li key={id} className="player-chip"><span className="pen" style={{ background: p.color }} />{p.name}<span className="tag">{p.identityDone ? "就緒" : "思考中…"}</span></li>;
          })}
        </ul>
      </div>
    );
  }

  const toggle = <T,>(list: T[], x: T, max: number) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x].slice(-max));
  const startRes = { ...content.rules.startingResources };
  for (const d of dirs) {
    const s = content.identities.find((i) => i.id === d)!.start;
    for (const [k, v] of Object.entries(s)) (startRes as Record<string, number>)[k] = ((startRes as Record<string, number>)[k] ?? 0) + Math.round((v as number) * (dirs.length === 1 ? 1.5 : 1));
  }
  const ready = dirs.length >= 1 && ability && objs.length === 2 && start;

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api.action(session, { type: "SET_IDENTITY", directions: dirs, abilityId: ability, objectiveIds: objs, startPoi: start });
      if (!r.result.ok) setErr(r.result.error ?? "失敗");
      setView(r.state);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="page">
      <div>
        <h1 style={{ fontSize: 34 }}>這一局，你是誰？</h1>
        <p className="muted">身份不是職業。選方向、選能力、選目標，之後你在城市裡做的事也會慢慢改變它。</p>
      </div>

      <section className="step">
        <h2>1・玩法方向</h2>
        <p className="muted small">選 1～2 個。只選 1 個會得到 1.5 倍的起始加成。</p>
        <div className="choice-grid">
          {content.identities.map((i) => (
            <button key={i.id} className={`choice ${dirs.includes(i.id) ? "on" : ""}`} onClick={() => setDirs(toggle(dirs, i.id, 2))} aria-pressed={dirs.includes(i.id)}>
              <span className="t"><span style={{ color: IDENTITY_COLOR[i.id] }}>●</span> {i.icon} {i.name}</span>
              <span className="d">{i.description}</span>
              <span className="d">起始 {fmtRes(i.start)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="step">
        <h2>2・起始能力</h2>
        <p className="muted small">從中選一個。第 {content.rules.abilityDraftRounds.join("、")} 回合開始時還會再選。</p>
        <div className="choice-grid">
          {me.abilityOffer.map((id) => {
            const a = content.abilityById[id];
            return (
              <button key={id} className={`choice ${ability === id ? "on" : ""}`} onClick={() => setAbility(id)} aria-pressed={ability === id}>
                <span className="t">{a.name}</span>
                <span className="d">{a.description}</span>
                <span className="d" style={{ color: IDENTITY_COLOR[a.direction] }}>{content.identities.find((i) => i.id === a.direction)?.name ?? ""}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="step">
        <h2>3・秘密目標</h2>
        <p className="muted small">三個裡保留兩個。只有你看得到，終局才會揭曉。</p>
        <div className="choice-grid">
          {me.objectiveOffer.map((id) => {
            const o = content.objectiveById[id];
            return (
              <button key={id} className={`choice ${objs.includes(id) ? "on" : ""}`} onClick={() => setObjs(toggle(objs, id, 2))} aria-pressed={objs.includes(id)}>
                <span className="t">{o.name} <span className="tag">{o.vp} 分</span></span>
                <span className="d">{o.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="step">
        <h2>4・從哪裡出發</h2>
        <div className="choice-grid">
          {hubs.map((p) => (
            <button key={p.id} className={`choice ${start === p.id ? "on" : ""}`} onClick={() => setStart(p.id)} aria-pressed={start === p.id}>
              <span className="t">{p.name}</span>
              <span className="d">{content.districtById[p.district].name}・{p.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="row">
        <button className="btn primary" disabled={!ready || busy} onClick={submit}>出發</button>
        {dirs.length > 0 && <span className="small">起始資源：{fmtRes(startRes).replace(/\+/g, "")}</span>}
        {err && <span className="error">{err}</span>}
      </div>
    </div>
  );
}
