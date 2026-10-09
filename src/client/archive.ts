// City Archive — the player's personal history with the city (stored in this browser).
import type { GameView } from "../shared/types";

export interface ArchiveGame { id: string; date: number; rank: number; players: number; score: number; title: string; headline: string }
export interface Archive { explored: string[]; achievements: string[]; games: ArchiveGame[]; firsts: string[] }
const KEY = "city-archive";

export function loadArchive(): Archive {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Archive;
  } catch {
    /* ignore */
  }
  return { explored: [], achievements: [], games: [], firsts: [] };
}

export function recordGame(view: GameView, poiName: (id: string) => string): Archive {
  const a = loadArchive();
  const me = view.me && view.players[view.me];
  if (!me || !view.result || a.games.some((g) => g.id === view.id)) return a;
  for (const id of me.visited) {
    if (!a.explored.includes(id)) {
      a.explored.push(id);
      if (a.explored.length > 1) a.firsts.unshift(`第一次來到 ${poiName(id)}`);
    }
  }
  for (const ach of view.result.report.achievements) if (ach.playerId === me.id && !a.achievements.includes(ach.name)) a.achievements.push(ach.name);
  const line = view.result.report.playerLines.find((l) => l.playerId === me.id);
  a.games.unshift({
    id: view.id,
    date: Date.now(),
    rank: view.result.ranking.indexOf(me.id) + 1,
    players: view.playerOrder.length,
    score: view.result.scores[me.id].total,
    title: line?.title ?? "",
    headline: view.result.report.headline,
  });
  a.games = a.games.slice(0, 30);
  a.firsts = a.firsts.slice(0, 12);
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* ignore */
  }
  return a;
}
