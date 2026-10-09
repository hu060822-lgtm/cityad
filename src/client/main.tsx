import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { GameView } from "../shared/types";
import { api, loadSession, saveSession, type Session } from "./api";
import Home from "./components/Home";
import Lobby from "./components/Lobby";
import Identity from "./components/Identity";
import Game from "./components/Game";
import Results from "./components/Results";

export interface Meta { debug: boolean; bots: { id: string; name: string }[] }

function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [view, setView] = useState<GameView | null>(null);
  const [meta, setMeta] = useState<Meta>({ debug: false, bots: [] });
  const [err, setErr] = useState("");
  const versionRef = useRef(0);

  useEffect(() => { api.meta().then(setMeta).catch(() => {}); }, []);

  const accept = useCallback((v: GameView) => {
    versionRef.current = v.version;
    setView(v);
  }, []);

  const leave = useCallback(() => {
    saveSession(null);
    setSession(null);
    setView(null);
    versionRef.current = 0;
  }, []);

  // HTTP polling (GDD §49) — cheap: server answers {unchanged} when version matches.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await api.state(session, versionRef.current || undefined);
        if (!alive) return;
        if (!("unchanged" in r)) accept(r);
        setErr("");
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 404 || status === 401 || status === 403) { leave(); return; }
        setErr("連線不穩，重新連線中…");
      }
      if (alive) timer = setTimeout(tick, document.hidden ? 6000 : 1800);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [session, accept, leave]);

  const enter = (s: Session) => { saveSession(s); versionRef.current = 0; setSession(s); };

  if (!session) return <Home onEnter={enter} />;
  if (!view) return <div className="page"><p className="muted">載入中…{err && <span className="error"> {err}</span>}</p></div>;
  const props = { session, view, setView: accept, meta, leave };
  return (
    <>
      {err && <div className="toast err" style={{ position: "fixed", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 30 }}>{err}</div>}
      {view.status === "lobby" && <Lobby {...props} />}
      {view.status === "identity" && <Identity {...props} />}
      {view.status === "playing" && <Game {...props} />}
      {view.status === "finished" && <Results {...props} />}
    </>
  );
}

export interface PageProps { session: Session; view: GameView; setView: (v: GameView) => void; meta: Meta; leave: () => void }

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
