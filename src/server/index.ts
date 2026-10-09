import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  getContent, validateContent, createGame, addPlayer, removePlayer, setRounds, startGame, applyAction, runBots,
  handleTimeout, viewFor, runDebug, BOT_STRATEGIES, BOT_NAMES, type DebugCommand,
} from "../engine";
import type { Action, BotStrategy, GameState } from "../shared/types";
import { MemoryStore, PgStore, type GameRecord, type Store } from "./store";

const PORT = Number(process.env.PORT ?? 3000);
const ENABLE_DEBUG = process.env.ENABLE_DEBUG === "true";
const ADMIN_KEY = process.env.ADMIN_KEY ?? "";
const content = getContent();
const problems = validateContent(content);
if (problems.length) {
  console.error("Content validation failed:\n" + problems.join("\n"));
  process.exit(1);
}

const store: Store = process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new MemoryStore();

// ---------- in-process cache + per-game lock (single Render instance) ----------
const cache = new Map<string, GameRecord>();
const locks = new Map<string, Promise<unknown>>();

async function getRecord(id: string): Promise<GameRecord | null> {
  const hit = cache.get(id);
  if (hit) return hit;
  const rec = await store.load(id);
  if (rec) cache.set(id, rec);
  return rec;
}

/** Serialize all mutations of one game; persist inside the lock (transaction in Postgres). */
async function withGame<T>(id: string, fn: (rec: GameRecord) => T | Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.then(async () => {
    try {
      const rec = await getRecord(id);
      if (!rec) throw new HttpError(404, "找不到這場遊戲");
      const seqBefore = rec.state.counters.seq;
      const before = rec.state.version;
      const out = await fn(rec);
      if (rec.state.version !== before || rec.state.counters.seq !== seqBefore) {
        await store.save(rec, rec.state.actions.filter((a) => a.seq > seqBefore));
      }
      return out;
    } catch (e) {
      cache.delete(id); // drop possibly half-mutated state; reload from store next time
      throw e;
    }
  });
  locks.set(id, run.catch(() => undefined));
  return run;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(24).toString("hex");
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");

function auth(rec: GameRecord, req: Request): string {
  const token = String(req.header("x-player-token") ?? "");
  const pid = Object.entries(rec.tokens).find(([, t]) => t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token)))?.[0];
  if (!pid) throw new HttpError(401, "身份驗證失敗，請重新加入遊戲");
  return pid;
}

function view(state: GameState, pid: string | null) {
  return viewFor(content, state, pid);
}

// ---------- tiny rate limiter ----------
const buckets = new Map<string, { n: number; t: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? "x";
  const now = Date.now();
  const b = buckets.get(key) ?? { n: 0, t: now };
  if (now - b.t > 10_000) (b.n = 0, (b.t = now));
  b.n += 1;
  buckets.set(key, b);
  if (b.n > 300) return res.status(429).json({ error: "請求太頻繁，請稍後再試" });
  next();
}

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));
app.use("/api", rateLimit);

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e: unknown) => {
    const status = e instanceof HttpError ? e.status : 400;
    const msg = e instanceof Error ? e.message : String(e);
    if (!(e instanceof HttpError)) console.warn("[api]", req.method, req.path, msg);
    res.status(status).json({ error: msg });
  });

app.get("/api/health", (_req, res) => res.json({ ok: true, store: store.kind, pois: content.pois.length, debug: ENABLE_DEBUG }));

app.get("/api/meta", (_req, res) => res.json({ debug: ENABLE_DEBUG, bots: BOT_STRATEGIES.map((s) => ({ id: s, name: BOT_NAMES[s] })) }));

app.post("/api/games", wrap(async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) throw new HttpError(400, "請輸入名字");
  let code = newCode();
  for (let i = 0; i < 5 && (await store.findIdByCode(code)); i++) code = newCode();
  const state = createGame(content, { id: newId(), code, debug: ENABLE_DEBUG });
  const pid = newId();
  addPlayer(content, state, { id: pid, name });
  const rec: GameRecord = { state, tokens: { [pid]: newToken() } };
  cache.set(state.id, rec);
  await store.save(rec, []);
  res.json({ gameId: state.id, code, playerId: pid, token: rec.tokens[pid] });
}));

app.post("/api/games/join", wrap(async (req, res) => {
  const code = String(req.body?.code ?? "").trim().toUpperCase();
  const name = String(req.body?.name ?? "").trim();
  if (!name) throw new HttpError(400, "請輸入名字");
  const id = await store.findIdByCode(code);
  if (!id) throw new HttpError(404, `找不到房間 ${code}`);
  const out = await withGame(id, (rec) => {
    const pid = newId();
    addPlayer(content, rec.state, { id: pid, name });
    rec.tokens[pid] = newToken();
    return { gameId: id, code, playerId: pid, token: rec.tokens[pid] };
  });
  res.json(out);
}));

app.get("/api/games/:id/state", wrap(async (req, res) => {
  const rec = await getRecord(req.params.id);
  if (!rec) throw new HttpError(404, "找不到這場遊戲");
  const pid = auth(rec, req);
  const since = Number(req.query.since ?? 0);
  if (since && since === rec.state.version) return res.json({ unchanged: true, version: since });
  res.json(view(rec.state, pid));
}));

app.post("/api/games/:id/lobby", wrap(async (req, res) => {
  const out = await withGame(req.params.id, (rec) => {
    const pid = auth(rec, req);
    const s = rec.state;
    const op = String(req.body?.op ?? "");
    if (op === "leave") {
      removePlayer(s, pid);
      delete rec.tokens[pid];
      return { ok: true };
    }
    if (s.hostId !== pid) throw new HttpError(403, "只有房主可以操作");
    switch (op) {
      case "add_bot": {
        const strategy = (BOT_STRATEGIES.includes(req.body?.strategy) ? req.body.strategy : "greedy") as BotStrategy;
        const n = Object.values(s.players).filter((p) => p.isBot).length + 1;
        addPlayer(content, s, { id: newId(), name: `${BOT_NAMES[strategy]}${n}`, isBot: true, botStrategy: strategy });
        break;
      }
      case "remove": {
        const target = String(req.body?.playerId ?? "");
        if (target === pid) throw new HttpError(400, "房主不能移除自己");
        removePlayer(s, target);
        delete rec.tokens[target];
        break;
      }
      case "rounds":
        setRounds(content, s, Number(req.body?.rounds));
        break;
      case "timeout": {
        const sec = Number(req.body?.seconds);
        if (![120, 300, 600, 1200].includes(sec)) throw new HttpError(400, "不支援的時限");
        s.settings.turnTimeoutSec = sec;
        s.version += 1;
        break;
      }
      case "start":
        startGame(content, s);
        runBots(content, s);
        break;
      default:
        throw new HttpError(400, "未知操作");
    }
    return view(s, pid);
  });
  res.json(out);
}));

app.post("/api/games/:id/action", wrap(async (req, res) => {
  const out = await withGame(req.params.id, (rec) => {
    const pid = auth(rec, req);
    const action = req.body?.action as Action;
    if (!action || typeof action.type !== "string") throw new HttpError(400, "缺少行動");
    const result = applyAction(content, rec.state, pid, action);
    if (result.ok) runBots(content, rec.state);
    return { result, state: view(rec.state, pid) };
  });
  res.json(out);
}));

app.get("/api/games/:id/replay", wrap(async (req, res) => {
  const rec = await getRecord(req.params.id);
  if (!rec) throw new HttpError(404, "找不到這場遊戲");
  auth(rec, req);
  if (rec.state.status !== "finished") throw new HttpError(403, "遊戲結束後才能查看完整紀錄");
  res.json({ seed: rec.state.rng.seed, actions: rec.state.actions });
}));

app.post("/api/games/:id/debug", wrap(async (req, res) => {
  if (!ENABLE_DEBUG) throw new HttpError(404, "Not found");
  const out = await withGame(req.params.id, (rec) => {
    const pid = auth(rec, req);
    runDebug(content, rec.state, req.body as DebugCommand);
    runBots(content, rec.state);
    return view(rec.state, pid);
  });
  res.json(out);
}));

// ---------- admin (read-only) ----------
app.get("/api/admin/summary", wrap(async (req, res) => {
  if (!ADMIN_KEY || req.header("x-admin-key") !== ADMIN_KEY) throw new HttpError(404, "Not found");
  const games = await store.listRecent(200);
  const finished = games.filter((g) => g.state?.result);
  const winnerDir: Record<string, number> = {};
  let rounds = 0, contests = 0, trades = 0, apLeft = 0, turns = 0;
  for (const g of finished) {
    const s = g.state!;
    const w = s.players[s.result!.winners[0]];
    for (const d of w.directions) winnerDir[d] = (winnerDir[d] ?? 0) + 1;
    rounds += s.settings.totalRounds;
    for (const p of Object.values(s.players)) {
      contests += p.stats.contestsStarted ?? 0;
      trades += p.stats.trades ?? 0;
      apLeft += p.stats.apWasted ?? 0;
    }
    turns += s.settings.totalRounds * s.playerOrder.length;
    const len = s.updatedAt - s.createdAt;
    void len;
  }
  res.json({
    store: store.kind,
    games: games.map(({ state: _s, ...g }) => g),
    finished: finished.length,
    metrics: finished.length
      ? {
          avg_rounds: rounds / finished.length,
          contests_per_game: contests / finished.length,
          trades_per_game: trades / 2 / finished.length,
          avg_ap_left_per_turn: apLeft / Math.max(1, turns),
          avg_game_minutes: finished.reduce((s, g) => s + (g.state!.updatedAt - g.state!.createdAt), 0) / finished.length / 60000,
          winner_directions: winnerDir,
        }
      : null,
  });
}));

// ---------- static client ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = [path.resolve(here, "../client"), path.resolve(here, "../../dist/client")].find((d) => fs.existsSync(path.join(d, "index.html")));
if (clientDir) {
  app.use(express.static(clientDir, { maxAge: "1h", index: false }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
} else {
  app.get("/", (_req, res) => res.send("Client not built. In development run `npm run dev` and open http://localhost:5173"));
}

// ---------- AFK ticker ----------
setInterval(async () => {
  for (const [id, rec] of cache) {
    if (rec.state.status !== "playing" && rec.state.status !== "identity") {
      if (rec.state.status === "finished" && Date.now() - rec.state.updatedAt > 3600_000) cache.delete(id);
      continue;
    }
    try {
      await withGame(id, (r) => handleTimeout(content, r.state));
    } catch (e) {
      console.warn("[ticker]", id, e);
    }
  }
}, 5000).unref();

await store.init();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`CITY server listening on 0.0.0.0:${PORT} (store: ${store.kind}, debug: ${ENABLE_DEBUG})`);
});
