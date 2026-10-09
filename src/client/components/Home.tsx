import { useState } from "react";
import { api, type Session } from "../api";
import { loadArchive } from "../archive";
import { content } from "../ctx";
import CityMap from "./CityMap";

export default function Home({ onEnter }: { onEnter: (s: Session) => void }) {
  const [name, setName] = useState(() => localStorage.getItem("city-name") ?? "");
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const archive = loadArchive();

  const go = async (fn: () => Promise<Session>) => {
    if (!name.trim()) return setErr("先寫下你的名字");
    setBusy(true); setErr("");
    try {
      localStorage.setItem("city-name", name.trim());
      onEnter(await fn());
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="home">
      <div className="home-map">
        <CityMap decorative />
        <div className="home-title">
          <div className="big">CITY 台中</div>
          <div className="sub">一場發生在真實台中市的多人策略桌遊。你決定自己是誰、要去哪裡、要讓這座城市變成什麼樣子。</div>
        </div>
      </div>
      <div className="home-side">
        <section>
          <h2>進入城市</h2>
          <label className="small muted" htmlFor="nm">你的名字</label>
          <input id="nm" type="text" maxLength={16} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：阿緯" />
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => go(() => api.create(name.trim()))}>開新房間</button>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <input type="text" aria-label="房間代碼" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="房間代碼" style={{ width: 130, letterSpacing: ".15em" }} />
            <button className="btn" disabled={busy || code.length < 4} onClick={() => go(() => api.join(code, name.trim()))}>加入</button>
          </div>
          {err && <p className="error">{err}</p>}
        </section>

        <section>
          <h2>怎麼玩</h2>
          <p className="small">每回合你有 6 AP。沿著地圖連線移動、探索地點、投資取得控制權、和別人交易或發委託。中途城市會下雨、辦活動、塞車；後期會出現一場需要大家一起處理的城市危機。</p>
          <p className="small">分數來自控制的地點、地點組合、地區主導、探索、城市目標，以及只有你知道的秘密目標。錢歸零也不會出局，只會進入「困境狀態」，打開新的路。</p>
        </section>

        <section>
          <h2>我的城市檔案</h2>
          {archive.games.length === 0 ? (
            <p className="small muted">還沒有紀錄。玩完第一局，這裡會記下你走過的台中。</p>
          ) : (
            <>
              <p className="small">已探索台中 <b>{archive.explored.length}</b> / {content.pois.length} 個地點・{archive.games.length} 局・{archive.achievements.length} 個成就</p>
              <ul className="archive-list">
                {archive.games.slice(0, 5).map((g) => (
                  <li key={g.id}>第 {g.rank} 名／{g.players} 人・{g.score} 分・{g.title}<br /><span className="muted">{g.headline}</span></li>
                ))}
              </ul>
              {archive.firsts.length > 0 && <p className="small muted">{archive.firsts.slice(0, 3).join("・")}</p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
