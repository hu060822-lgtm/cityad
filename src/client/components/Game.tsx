import { useEffect, useMemo, useState } from "react";
import type { Action, GameView, Resources } from "../../shared/types";
import { api } from "../api";
import {
  content, check, asState, poiName, fmtRes, currentPlayerId, phaseName, shortestPath, isClosed, hasTag,
  identityMix, objectiveProgress, playerSynergies, districtDominance, CATEGORY_NAME, TIER_NAME, IDENTITY_COLOR,
} from "../ctx";
import { moveCost } from "../../engine/game";
import type { PageProps } from "../main";
import CityMap from "./CityMap";

type Toast = { text: string; err?: boolean } | null;

export default function Game({ session, view, setView, meta }: PageProps) {
  const me = view.me ? view.players[view.me] : null;
  const [selected, setSelected] = useState<string | null>(me?.position ?? null);
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState(false);
  const cur = currentPlayerId(asState(view));
  const myTurn = !!me && cur === me.id;

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);

  const act = async (a: Action): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await api.action(session, a);
      setView(r.state);
      setToast(r.result.ok ? { text: r.result.messages.join("；") } : { text: r.result.error ?? "無法執行", err: true });
      return r.result.ok;
    } catch (e) {
      setToast({ text: (e as Error).message, err: true });
      return false;
    } finally { setBusy(false); }
  };

  const moveCosts = useMemo(() => {
    const out: Record<string, number> = {};
    if (!me?.position || !myTurn) return out;
    for (const { to } of content.adjacency[me.position]) {
      const c = moveCost(content, asState(view), me as never, to);
      if (c != null) out[to] = c;
    }
    return out;
  }, [view, me, myTurn]);

  const path = useMemo(() => {
    if (!me?.position || !selected || selected === me.position) return null;
    return shortestPath(content, me.position, selected);
  }, [me?.position, selected]);

  return (
    <div className="game">
      <TopBar view={view} myTurn={myTurn} busy={busy} onEnd={() => act({ type: "END_TURN" })} />
      <div className="map-wrap">
        <CityMap view={view} selected={selected} onSelect={setSelected} moveCosts={moveCosts} highlight={path?.path ?? []} focus={me?.position ?? "tc_station"} />
      </div>
      <PoiPanel view={view} poiId={selected} myTurn={myTurn} busy={busy} act={act} path={path} toast={toast} />
      <Side view={view} session={session} setView={setView} act={act} busy={busy} debug={meta.debug} onSelect={setSelected} />
      {me && me.abilityOffer.length > 0 && <AbilityModal ids={me.abilityOffer} onPick={(id) => act({ type: "CHOOSE_ABILITY", abilityId: id })} />}
    </div>
  );
}

// ---------------------------------------------------------------- top bar
function TopBar({ view, myTurn, busy, onEnd }: { view: GameView; myTurn: boolean; busy: boolean; onEnd: () => void }) {
  const me = view.me ? view.players[view.me] : null;
  const cur = currentPlayerId(asState(view));
  const curP = cur ? view.players[cur] : null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.round((view.turnStartedAt + view.settings.turnTimeoutSec * 1000 - now) / 1000));
  const ev = view.currentEvents[view.currentEvents.length - 1];
  const maxAp = Math.max(me?.ap ?? 0, content.rules.baseAP);
  const R = view.settings.totalRounds;

  return (
    <div className="topbar">
      <span className="round">第 {view.round} / {R} 回合</span>
      <span className="phase">{phaseName(asState(view))}</span>
      {view.round > R - content.rules.finaleRounds && <span className="phase" style={{ borderColor: "#c8372d", color: "#c8372d" }}>終局倒數 {R - view.round + 1}</span>}
      {ev && <span className="event-strip" title={`${ev.name}：${ev.text}`}><b>{ev.name}</b>　{ev.text}</span>}
      <div className="turn">
        {myTurn ? (
          <>
            <span className="ap-pips" aria-label={`剩餘 ${me!.ap} AP`}>
              {Array.from({ length: maxAp }, (_, i) => <i key={i} className={i < me!.ap ? "full" : ""} />)}
            </span>
            <b>{me!.ap} AP</b>
            <span className="muted small">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>
            <button className="btn primary" disabled={busy} onClick={onEnd}>結束回合</button>
          </>
        ) : curP ? (
          <span className="small"><span className="pen" style={{ background: curP.color, display: "inline-block", verticalAlign: "middle" }} /> 輪到 <b>{curP.name}</b>{curP.isBot ? "（AI）" : ""}<span className="muted">・{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span></span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- POI panel
function ActBtn({ view, a, label, busy, act, note }: { view: GameView; a: Action; label: string; busy: boolean; act: (a: Action) => void; note?: string }) {
  const c = check(view, a);
  const cost = c.cost ? fmtRes(c.cost).replace(/\+/g, "") : "";
  return (
    <button className="btn" disabled={busy || !c.ok} onClick={() => act(a)} title={c.ok ? note : c.error}>
      {label}
      <span className="ap">{c.ap ?? "—"} AP{cost && cost !== "無" ? `・${cost}` : ""}</span>
    </button>
  );
}

function PoiPanel({ view, poiId, myTurn, busy, act, path, toast }: {
  view: GameView; poiId: string | null; myTurn: boolean; busy: boolean; act: (a: Action) => Promise<boolean>;
  path: { path: string[]; cost: number } | null; toast: Toast;
}) {
  const me = view.me ? view.players[view.me] : null;
  const [info, setInfo] = useState(0);
  const [reward, setReward] = useState(content.rules.contractMinReward);
  if (!poiId) return <div className="poi-panel"><p className="muted">點地圖上的地點看資訊。{toast && <span className={`toast ${toast.err ? "err" : ""}`}>{toast.text}</span>}</p></div>;
  const p = content.poiById[poiId];
  const st = view.pois[poiId];
  const here = me?.position === poiId;
  const owner = st.owner ? view.players[st.owner] : null;
  const closed = isClosed(asState(view), poiId);
  const adjacent = me?.position ? content.adjacency[me.position].some((x) => x.to === poiId) : false;
  const crisisDef = view.crisis && !view.crisis.resolved ? content.crises.find((c) => c.id === view.crisis!.crisisId) : null;
  const stakes = Object.entries(st.stakes).filter(([, v]) => v > 0);

  const walk = async () => {
    if (!path) return;
    for (const step of path.path.slice(1)) {
      const ok = await act({ type: "MOVE", to: step });
      if (!ok) break;
    }
  };

  return (
    <div className="poi-panel">
      <div>
        <h3>{p.name}</h3>
        <div className="poi-meta">{CATEGORY_NAME[p.category] ?? p.category}・{TIER_NAME[p.tier]}・{p.region}／{content.districtById[p.district].name}</div>
        <p className="small" style={{ marginTop: 4 }}>{p.blurb}</p>
        <div className="poi-facts">
          <span className="muted">每回合收益</span><span>{fmtRes(p.income)}</span>
          <span className="muted">探索獎勵</span><span>{fmtRes(p.explore)}</span>
          {p.workPay > 0 && <><span className="muted">打工</span><span>${p.workPay}</span></>}
          <span className="muted">控制者</span>
          <span>{owner ? <><span style={{ color: owner.color }}>●</span> {owner.name}{st.level ? `・Lv.${st.level}` : ""}</> : "無"}{stakes.length > 0 && <span className="muted">（持股 {stakes.map(([id, v]) => `${view.players[id]?.name ?? "?"} ${v}`).join("、")}）</span>}</span>
          <span className="muted">防禦</span><span>{p.defense + st.level}</span>
          {closed && <><span className="muted">狀態</span><span className="error">暫停開放</span></>}
          {!p.verified && <><span className="muted">資料</span><span className="muted">座標待人工核實</span></>}
        </div>
      </div>
      <div className="poi-actions">
        {toast && <div className={`toast ${toast.err ? "err" : ""}`} style={{ width: "100%" }} role="status">{toast.text}</div>}
        {!me ? null : !myTurn ? (
          <p className="hint">還沒輪到你。你仍可以回應交易、選擇能力、查看地圖與紀錄。</p>
        ) : here ? (
          <>
            <ActBtn view={view} a={{ type: "EXPLORE" }} label="探索" busy={busy} act={act} note="第一次探索此地，取得探索獎勵" />
            <ActBtn view={view} a={{ type: "INVESTIGATE" }} label="調查" busy={busy} act={act} note="取得情報並預知下一回合事件" />
            {p.workPay > 0 && <ActBtn view={view} a={{ type: "WORK" }} label="打工" busy={busy} act={act} />}
            <ActBtn view={view} a={{ type: "INVEST" }} label="投資" busy={busy} act={act} note="取得 1 股；股份最多者控制此地" />
            {st.owner === me.id && <ActBtn view={view} a={{ type: "BUILD" }} label="建設" busy={busy} act={act} note="提升等級：收益、防禦、分數" />}
            {st.owner && st.owner !== me.id && (
              <span className="row">
                <ActBtn view={view} a={{ type: "CONTEST", infoSpend: info }} label="爭奪" busy={busy} act={act} note="影響力／持股／情報 + 骰子 對 防禦" />
                <label className="small">投入情報
                  <select value={info} onChange={(e) => setInfo(Number(e.target.value))} style={{ marginLeft: 4 }}>
                    {Array.from({ length: content.rules.contestMaxInfoSpend + 1 }, (_, i) => <option key={i} value={i} disabled={i > me.resources.info}>{i}</option>)}
                  </select>
                </label>
              </span>
            )}
            {crisisDef && hasTag(p, crisisDef.respondTags) && <ActBtn view={view} a={{ type: "RESPOND_CRISIS" }} label="回應危機" busy={busy} act={act} />}
            {p.tags.includes("hub") && <span className="hint">這裡是交通樞紐：點選其他樞紐可以轉乘。</span>}
          </>
        ) : (
          <>
            {adjacent && <ActBtn view={view} a={{ type: "MOVE", to: poiId }} label="移動到這裡" busy={busy} act={act} />}
            {!adjacent && path && (
              <button className="btn" disabled={busy || (me.ap ?? 0) < 1} onClick={walk}>
                沿路前往<span className="ap">約 {path.cost} AP・{path.path.length - 1} 段</span>
              </button>
            )}
            {me.position && content.poiById[me.position].tags.includes("hub") && p.tags.includes("hub") && (
              <ActBtn view={view} a={{ type: "TRANSIT", to: poiId }} label="轉乘前往" busy={busy} act={act} />
            )}
            {path && !adjacent && <span className="hint">路線：{path.path.map(poiName).join(" → ")}</span>}
          </>
        )}
        {me && myTurn && (
          <span className="row" style={{ width: "100%", marginTop: 4 }}>
            <label className="small">發布委託到此地，報酬 $
              <input type="number" min={content.rules.contractMinReward} step={10} value={reward} onChange={(e) => setReward(Number(e.target.value))} style={{ width: 80, marginLeft: 4 }} />
            </label>
            <ActBtn view={view} a={{ type: "POST_CONTRACT", poiId, reward }} label="發布委託" busy={busy} act={act} note="別人來此探索或調查即完成，雙方都有回報" />
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- side panel
type Tab = "me" | "deals" | "players" | "log" | "dev";

function Side({ view, session, setView, act, busy, debug, onSelect }: {
  view: GameView; session: PageProps["session"]; setView: (v: GameView) => void; act: (a: Action) => Promise<boolean>;
  busy: boolean; debug: boolean; onSelect: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("me");
  const me = view.me ? view.players[view.me] : null;
  const incoming = view.trades.filter((t) => t.status === "open" && t.to === view.me).length;
  return (
    <aside className="side">
      {me && <MeCard view={view} />}
      <div className="tabs" role="tablist">
        {([["me", "目標"], ["deals", `委託交易${incoming ? `（${incoming}）` : ""}`], ["players", "玩家"], ["log", "紀錄"], ...(debug ? [["dev", "開發"]] : [])] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      <div className="tab-body">
        {tab === "me" && <GoalsTab view={view} act={act} busy={busy} />}
        {tab === "deals" && <DealsTab view={view} act={act} busy={busy} onSelect={onSelect} />}
        {tab === "players" && <PlayersTab view={view} />}
        {tab === "log" && <LogTab view={view} />}
        {tab === "dev" && <DevTab view={view} session={session} setView={setView} />}
      </div>
    </aside>
  );
}

function MeCard({ view }: { view: GameView }) {
  const me = view.players[view.me!];
  const mix = identityMix(content, me as never);
  return (
    <div className="me-card">
      <div className="name"><span className="pen" style={{ background: me.color }} />{me.name}{me.struggling && <span className="tag" style={{ color: "#c8372d" }}>困境狀態</span>}<span className="muted small" style={{ marginLeft: "auto", fontFamily: "var(--body)", fontWeight: 400 }}>公開估分 {me.scoreEstimate}</span></div>
      <div className="res">
        <div><b>${me.resources.money}</b><span>資金</span></div>
        <div><b>{me.resources.influence}</b><span>影響力</span></div>
        <div><b>{me.resources.info}</b><span>情報</span></div>
      </div>
      <div className="mix" aria-hidden>{mix.map((m) => <i key={m.id} style={{ width: `${m.pct}%`, background: IDENTITY_COLOR[m.id] }} />)}</div>
      <div className="mix-labels">{mix.map((m) => <span key={m.id}><span style={{ color: IDENTITY_COLOR[m.id] }}>●</span>{content.identities.find((i) => i.id === m.id)?.name} {m.pct}%</span>)}</div>
      <div className="small">{me.abilities.map((id) => <span key={id} className="tag" title={content.abilityById[id]?.description} style={{ marginLeft: 0, marginRight: 4 }}>{content.abilityById[id]?.name}</span>)}</div>
    </div>
  );
}

function GoalsTab({ view, act, busy }: { view: GameView; act: (a: Action) => Promise<boolean>; busy: boolean }) {
  const me = view.me ? view.players[view.me] : null;
  const s = asState(view);
  const goal = content.cityGoals.find((g) => g.id === view.cityGoalId);
  const crisisDef = view.crisis ? content.crises.find((c) => c.id === view.crisis!.crisisId) : null;
  const total = view.crisis ? Object.values(view.crisis.contributions).reduce((a, b) => a + b, 0) : 0;
  const dom = districtDominance(content, s);
  const syn = me ? playerSynergies(content, s, me.id) : [];
  const prog = me ? objectiveProgress(content, s, me as never) : [];
  return (
    <>
      {crisisDef && view.crisis && (
        <div className="crisis-box">
          <h4>城市危機：{crisisDef.name}{view.crisis.resolved ? (view.crisis.resolved === "success" ? "（已化解）" : "（失敗）") : ""}</h4>
          <p className="small">{crisisDef.text}</p>
          <div className="bar"><i style={{ width: `${Math.min(100, (total / view.crisis.target) * 100)}%` }} /></div>
          <p className="small muted">{total} / {view.crisis.target}・化解後依貢獻加分，失敗則所有人 {crisisDef.failure.vp} 分</p>
        </div>
      )}
      {!view.crisis && <p className="small muted">城市危機預計在第 {view.crisisRound} 回合爆發。</p>}
      {view.nextEvent && <div className="toast"><b>你得知下一回合：</b>{view.nextEvent.name}　<span className="muted">{view.nextEvent.text}</span></div>}
      {goal && <div><h4>公開城市目標・{goal.name}</h4><p className="small">{goal.description}</p></div>}
      {me && (
        <div>
          <h4>秘密目標</h4>
          <ul className="list">
            {prog.map(({ id, done }) => {
              const o = content.objectiveById[id];
              return <li key={id} className={done ? "done" : ""}>{o.name} <span className="tag">{o.vp} 分</span><br /><span className="small muted">{o.description}</span></li>;
            })}
          </ul>
          <p className="small muted" style={{ marginTop: 4 }}>已探索 {me.visited.length} 個地點</p>
        </div>
      )}
      <div>
        <h4>地點組合</h4>
        {syn.length ? <ul className="list">{syn.map((x) => <li key={x.def.id}><b>{x.def.name}</b> +{x.def.vp} 分<br /><span className="small muted">{x.pois.map(poiName).join("・")}</span></li>)}</ul>
          : <p className="small muted">控制彼此相近（2 段以內）的特定地點可形成組合：{content.synergies.map((x) => x.name).join("、")}。</p>}
      </div>
      <div>
        <h4>地區主導</h4>
        <ul className="list small">
          {content.districts.map((d) => <li key={d.id}><span style={{ color: d.color }}>■</span> {d.name}：{dom[d.id] ? view.players[dom[d.id]!]?.name : <span className="muted">無人</span>}</li>)}
        </ul>
      </div>
      {me && (me.struggling || me.abilities.some((a) => content.abilityById[a]?.effects.some((e) => e.type === "can_sell_info"))) && (
        <button className="btn" disabled={busy || !check(view, { type: "SELL_INFO" }).ok} onClick={() => act({ type: "SELL_INFO" })}>出售 1 情報</button>
      )}
    </>
  );
}

function DealsTab({ view, act, busy, onSelect }: { view: GameView; act: (a: Action) => Promise<boolean>; busy: boolean; onSelect: (id: string) => void }) {
  const me = view.me ? view.players[view.me] : null;
  const [to, setTo] = useState("");
  const [give, setGive] = useState<Resources>({});
  const [want, setWant] = useState<Resources>({});
  const others = view.playerOrder.filter((id) => id !== view.me);
  const open = view.contracts.filter((c) => c.status === "open");
  const mine = view.contracts.filter((c) => c.status === "accepted" && c.acceptedBy === view.me);
  const trades = view.trades.filter((t) => t.status === "open" && (t.to === view.me || t.from === view.me));
  const offer: Action = { type: "TRADE_OFFER", to: to || others[0] || "", give, want };
  const oc = check(view, offer);
  const resInput = (r: Resources, set: (r: Resources) => void, label: string) => (
    <div className="row small">
      <span style={{ width: 28 }}>{label}</span>
      {(["money", "influence", "info"] as const).map((k) => (
        <label key={k}>{k === "money" ? "$" : k === "influence" ? "影響" : "情報"}
          <input type="number" min={0} step={k === "money" ? 10 : 1} value={r[k] ?? 0} onChange={(e) => set({ ...r, [k]: Math.max(0, Number(e.target.value)) })} style={{ width: k === "money" ? 70 : 48, marginLeft: 2 }} />
        </label>
      ))}
    </div>
  );
  return (
    <>
      <div>
        <h4>可接的委託</h4>
        {open.length === 0 ? <p className="small muted">目前沒有。</p> : (
          <ul className="list">
            {open.map((c) => (
              <li key={c.id}>
                <button className="btn ghost small" onClick={() => onSelect(c.poiId)}>{poiName(c.poiId)}</button>
                {fmtRes(c.reward)}<span className="muted small">・{c.poster === "city" ? "市政府" : view.players[c.poster]?.name}・到第 {c.expiresRound} 回合</span>
                {c.underground && <span className="tag" style={{ color: "#c8372d" }}>地下</span>}
                <div><button className="btn small" disabled={busy || !check(view, { type: "ACCEPT_CONTRACT", contractId: c.id }).ok} title={check(view, { type: "ACCEPT_CONTRACT", contractId: c.id }).error} onClick={() => act({ type: "ACCEPT_CONTRACT", contractId: c.id })}>接下（0 AP）</button></div>
              </li>
            ))}
          </ul>
        )}
        <p className="small muted">接下後到該地探索或調查即完成。發布委託：在地圖點選目標地點，於下方面板設定報酬。</p>
      </div>
      {mine.length > 0 && (
        <div><h4>我接下的委託</h4><ul className="list">{mine.map((c) => <li key={c.id}><button className="btn ghost small" onClick={() => onSelect(c.poiId)}>{poiName(c.poiId)}</button>{fmtRes(c.reward)}</li>)}</ul></div>
      )}
      <div>
        <h4>交易</h4>
        {trades.length === 0 && <p className="small muted">沒有進行中的交易。</p>}
        <ul className="list">
          {trades.map((t) => {
            const from = view.players[t.from];
            const incoming = t.to === view.me;
            return (
              <li key={t.id}>
                {incoming ? <><b>{from.name}</b> 給你 {fmtRes(t.give)}，想換 {fmtRes(t.want)}</> : <>你向 <b>{view.players[t.to]?.name}</b> 提議：給 {fmtRes(t.give)}，換 {fmtRes(t.want)}</>}
                <div className="row" style={{ marginTop: 4 }}>
                  {incoming ? (
                    <>
                      <button className="btn small primary" disabled={busy} onClick={() => act({ type: "TRADE_RESPOND", tradeId: t.id, accept: true })}>接受</button>
                      <button className="btn small" disabled={busy} onClick={() => act({ type: "TRADE_RESPOND", tradeId: t.id, accept: false })}>拒絕</button>
                    </>
                  ) : <button className="btn small" disabled={busy} onClick={() => act({ type: "TRADE_CANCEL", tradeId: t.id })}>撤回</button>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      {me && others.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <h4>提出交易</h4>
          <select value={to || others[0]} onChange={(e) => setTo(e.target.value)} aria-label="交易對象">
            {others.map((id) => <option key={id} value={id}>{view.players[id].name}</option>)}
          </select>
          {resInput(give, setGive, "給")}
          {resInput(want, setWant, "換")}
          <p className="small muted">需和對方同一地區，或你在交通樞紐。給出的資源先託管，對方拒絕或過期會退回。</p>
          <button className="btn" disabled={busy || !oc.ok} title={oc.error} onClick={async () => { if (await act(offer)) { setGive({}); setWant({}); } }}>送出提案<span className="ap">{oc.ap ?? 1} AP</span></button>
          {!oc.ok && <span className="small muted">{oc.error}</span>}
        </div>
      )}
    </>
  );
}

function PlayersTab({ view }: { view: GameView }) {
  const order = [...view.playerOrder].sort((a, b) => view.players[b].scoreEstimate - view.players[a].scoreEstimate);
  const cur = currentPlayerId(asState(view));
  return (
    <>
      <p className="small muted">估分不含秘密目標。領先者投資較貴、較常成為事件焦點。</p>
      <ul className="list">
        {order.map((id) => {
          const p = view.players[id];
          const owned = Object.entries(view.pois).filter(([, s]) => s.owner === id).map(([pid]) => pid);
          return (
            <li key={id}>
              <div className="row"><span className="pen" style={{ background: p.color }} /><b>{p.name}</b>
                {p.isBot && <span className="tag">AI</span>}{p.autoPlayed && !p.isBot && <span className="tag">曾代打</span>}{p.struggling && <span className="tag" style={{ color: "#c8372d" }}>困境</span>}{id === cur && <span className="tag">行動中</span>}
                <span style={{ marginLeft: "auto" }}>{p.scoreEstimate} 分</span></div>
              <div className="small muted">${p.resources.money}・影響 {p.resources.influence}・情報 {p.resources.info}・探索 {p.visited.length}・位於 {p.position ? poiName(p.position) : "—"}</div>
              {owned.length > 0 && <div className="small">控制：{owned.map(poiName).join("、")}</div>}
              <div className="small">{p.abilities.map((a) => <span key={a} className="tag" style={{ marginLeft: 0, marginRight: 4 }} title={content.abilityById[a]?.description}>{content.abilityById[a]?.name}</span>)}</div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function LogTab({ view }: { view: GameView }) {
  const rows = [...view.log].reverse();
  return (
    <ul className="list log">
      {rows.map((l, i) => (
        <li key={i} className={l.kind}>
          <span className="muted">{new Date(l.t).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}</span> {l.playerId && <span style={{ color: view.players[l.playerId]?.color }}>●</span>} {l.text}
        </li>
      ))}
    </ul>
  );
}

function DevTab({ view, session, setView }: { view: GameView; session: PageProps["session"]; setView: (v: GameView) => void }) {
  const [ev, setEv] = useState(content.events[0]?.id ?? "");
  const [err, setErr] = useState("");
  const run = async (body: Record<string, unknown>) => { setErr(""); try { setView(await api.debug(session, body)); } catch (e) { setErr((e as Error).message); } };
  const me = view.me!;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="small muted">開發模式（ENABLE_DEBUG=true）。正式環境請關閉。</p>
      <div className="row">
        <button className="btn small" onClick={() => run({ cmd: "give", playerId: me, resources: { money: 500, influence: 3, info: 3 } })}>+$500 +3 +3</button>
        <button className="btn small" onClick={() => run({ cmd: "give_ap", playerId: me, ap: 6 })}>+6 AP</button>
        <button className="btn small" onClick={() => run({ cmd: "advance_turn" })}>跳過回合</button>
      </div>
      <div className="row">
        <select value={ev} onChange={(e) => setEv(e.target.value)} aria-label="事件">{content.events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
        <button className="btn small" onClick={() => run({ cmd: "trigger_event", eventId: ev })}>觸發事件</button>
      </div>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- ability draft
function AbilityModal({ ids, onPick }: { ids: string[]; onPick: (id: string) => void }) {
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="draft-h">
      <div className="modal">
        <h2 id="draft-h">城市給了你新的可能</h2>
        <p className="muted small">選一個能力，它會成為你身份的一部分。</p>
        <div className="choice-grid">
          {ids.map((id) => {
            const a = content.abilityById[id];
            return (
              <button key={id} className="choice" onClick={() => onPick(id)}>
                <span className="t">{a.name}</span>
                <span className="d">{a.description}</span>
                <span className="d" style={{ color: IDENTITY_COLOR[a.direction] }}>{content.identities.find((i) => i.id === a.direction)?.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
