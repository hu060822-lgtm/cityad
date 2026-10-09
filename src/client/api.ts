import type { Action, ActionResult, GameView } from "../shared/types";

export interface Session { gameId: string; playerId: string; token: string; code: string }
const KEY = "city-session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}

async function req<T>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(opts.token ? { "x-player-token": opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `伺服器回應異常（${res.status}）` }));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `錯誤 ${res.status}`), { status: res.status });
  return data as T;
}

export const api = {
  meta: () => req<{ debug: boolean; bots: { id: string; name: string }[] }>("/api/meta"),
  create: (name: string) => req<Session>("/api/games", { method: "POST", body: { name } }),
  join: (code: string, name: string) => req<Session>("/api/games/join", { method: "POST", body: { code, name } }),
  state: (s: Session, since?: number) =>
    req<GameView | { unchanged: true; version: number }>(`/api/games/${s.gameId}/state${since ? `?since=${since}` : ""}`, { token: s.token }),
  lobby: (s: Session, body: Record<string, unknown>) => req<GameView>(`/api/games/${s.gameId}/lobby`, { method: "POST", body, token: s.token }),
  action: (s: Session, action: Action) =>
    req<{ result: ActionResult; state: GameView }>(`/api/games/${s.gameId}/action`, { method: "POST", body: { action }, token: s.token }),
  debug: (s: Session, body: Record<string, unknown>) => req<GameView>(`/api/games/${s.gameId}/debug`, { method: "POST", body, token: s.token }),
};
