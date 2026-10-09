import type {
  Content, GameState, PlayerState, POIDef, Scope, ModifierKey, Resources, ResourceKey, AbilityEffect, LogEntry, ActionType,
} from "../shared/types";
import { RESOURCE_KEYS } from "../shared/types";

// ---------- tags & scopes ----------

/** "a|b" matches if POI has tag a or b. Category also counts as a tag. */
export function hasTag(poi: POIDef, tagExpr: string): boolean {
  return tagExpr.split("|").some((t) => poi.tags.includes(t) || poi.category === t);
}

export function matchesScope(poi: POIDef, scope: Scope | undefined): boolean {
  if (!scope) return true;
  if (scope.poi && poi.id !== scope.poi) return false;
  if (scope.district && poi.district !== scope.district) return false;
  if (scope.category && poi.category !== scope.category) return false;
  if (scope.tag && !hasTag(poi, scope.tag)) return false;
  return true;
}

export function resolveScope(scope: Scope | undefined, vars: Record<string, string>): Scope {
  const out: Scope = {};
  if (!scope) return out;
  for (const [k, v] of Object.entries(scope) as [keyof Scope, string][]) {
    out[k] = v.startsWith("$") ? vars[v.slice(1)] ?? v : v;
  }
  return out;
}

// ---------- modifiers from events ----------

function activeMods(state: GameState, key: ModifierKey, poi: POIDef | null) {
  return state.modifiers.filter(
    (m) => m.key === key && m.untilRound >= state.round && (poi ? matchesScope(poi, m.scope) : Object.keys(m.scope).length === 0),
  );
}

export function modAdd(state: GameState, key: ModifierKey, poi: POIDef | null): number {
  return activeMods(state, key, poi).reduce((s, m) => s + (m.value ?? 0), 0);
}

export function modMult(state: GameState, key: ModifierKey, poi: POIDef | null): number {
  return activeMods(state, key, poi).reduce((s, m) => s * (m.value ?? 1), 1);
}

export function modResources(state: GameState, key: ModifierKey, poi: POIDef): Resources {
  const out: Resources = {};
  for (const m of activeMods(state, key, poi)) addInto(out, m.resources ?? {});
  return out;
}

export function isClosed(state: GameState, poiId: string): boolean {
  return (state.pois[poiId]?.closedUntil ?? 0) >= state.round;
}

// ---------- player ability effects (data-driven) ----------

export function abilityEffects<T extends AbilityEffect["type"]>(
  content: Content, player: PlayerState, type: T,
): Extract<AbilityEffect, { type: T }>[] {
  const out: Extract<AbilityEffect, { type: T }>[] = [];
  for (const id of player.abilities) {
    const def = content.abilityById[id];
    if (!def) continue;
    for (const e of def.effects) if (e.type === type) out.push(e as Extract<AbilityEffect, { type: T }>);
  }
  return out;
}

export function hasEffect(content: Content, player: PlayerState, type: AbilityEffect["type"]): boolean {
  return abilityEffects(content, player, type).length > 0;
}

export function effectSum(content: Content, player: PlayerState, type: "ap_bonus" | "upkeep_money" | "contest_bonus" | "defense_bonus"): number {
  return abilityEffects(content, player, type).reduce((s, e) => s + (e as { value: number }).value, 0);
}

export function effectMult(content: Content, player: PlayerState, type: "invest_cost_mult" | "work_pay_mult" | "income_mult" | "build_cost_mult"): number {
  return abilityEffects(content, player, type).reduce((s, e) => s * (e as { value: number }).value, 1);
}

export function effectResources(content: Content, player: PlayerState, type: "explore_bonus" | "trade_bonus" | "contract_bonus"): Resources {
  const out: Resources = {};
  for (const e of abilityEffects(content, player, type)) addInto(out, (e as { resources: Resources }).resources);
  return out;
}

export function actionBonus(content: Content, player: PlayerState, action: ActionType): Resources {
  const out: Resources = {};
  for (const e of abilityEffects(content, player, "action_bonus")) if (e.action === action) addInto(out, e.resources);
  return out;
}

export function apOverride(content: Content, player: PlayerState, action: ActionType): number | null {
  const list = abilityEffects(content, player, "ap_override").filter((e) => e.action === action);
  return list.length ? Math.min(...list.map((e) => e.value)) : null;
}

// ---------- resources ----------

export function addInto(target: Resources, add: Resources, mult = 1): Resources {
  for (const k of RESOURCE_KEYS) if (add[k]) target[k] = (target[k] ?? 0) + Math.round(add[k]! * mult);
  return target;
}

export function gain(player: PlayerState, res: Resources, mult = 1) {
  for (const k of RESOURCE_KEYS) {
    if (!res[k]) continue;
    player.resources[k] = Math.max(0, player.resources[k] + Math.round(res[k]! * mult));
  }
}

export function canAfford(player: PlayerState, cost: Resources): boolean {
  return RESOURCE_KEYS.every((k) => (cost[k] ?? 0) <= player.resources[k]);
}

export function pay(player: PlayerState, cost: Resources) {
  for (const k of RESOURCE_KEYS) if (cost[k]) player.resources[k] -= cost[k]!;
}

const RES_LABEL: Record<ResourceKey, string> = { money: "$", influence: "影響力", info: "情報" };
export function fmtRes(res: Resources): string {
  const parts: string[] = [];
  for (const k of RESOURCE_KEYS) {
    const v = res[k];
    if (!v) continue;
    parts.push(k === "money" ? `${v >= 0 ? "+" : "-"}$${Math.abs(v)}` : `${v >= 0 ? "+" : ""}${v} ${RES_LABEL[k]}`);
  }
  return parts.join("、") || "無";
}

export function isEmpty(res: Resources): boolean {
  return RESOURCE_KEYS.every((k) => !res[k]);
}

// ---------- misc ----------

export function nextId(state: GameState, prefix: string): string {
  state.counters.id += 1;
  return `${prefix}${state.counters.id}`;
}

export function log(state: GameState, kind: LogEntry["kind"], text: string, playerId?: string) {
  state.log.push({ t: Date.now(), round: state.round, kind, text, playerId });
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

export function bump(player: PlayerState, stat: string, by = 1) {
  player.stats[stat] = (player.stats[stat] ?? 0) + by;
}

export function pname(state: GameState, id: string | null | undefined): string {
  if (!id) return "無";
  if (id === "city") return "市政府";
  return state.players[id]?.name ?? "?";
}

export function currentPlayerId(state: GameState): string | null {
  if (state.status !== "playing") return null;
  return state.turnOrder[state.turnIndex] ?? null;
}

export function phaseName(state: GameState): string {
  const R = state.settings.totalRounds;
  const r = state.round;
  if (state.status === "lobby") return "大廳";
  if (state.status === "identity") return "建立身份";
  if (state.status === "finished") return "結算";
  const c = { openingRounds: 2, finaleRounds: 2 };
  if (r <= c.openingRounds) return "開局探索";
  if (r > R - c.finaleRounds) return "終局倒數";
  if (state.crisis && r >= state.crisis.startRound) return "城市危機";
  if (r <= Math.ceil(R / 2)) return "擴張";
  return "衝突";
}

/** Shortest path by AP (Dijkstra, ignoring dynamic modifiers). */
export function shortestPath(content: Content, from: string, to: string): { path: string[]; cost: number } | null {
  const dist: Record<string, number> = { [from]: 0 };
  const prev: Record<string, string> = {};
  const open = new Set([from]);
  while (open.size) {
    let u = "";
    let best = Infinity;
    for (const n of open) if (dist[n] < best) (best = dist[n], (u = n));
    open.delete(u);
    if (u === to) break;
    for (const { to: v, edge } of content.adjacency[u]) {
      const d = best + (edge.cost ?? 1);
      if (dist[v] === undefined || d < dist[v]) {
        dist[v] = d;
        prev[v] = u;
        open.add(v);
      }
    }
  }
  if (dist[to] === undefined) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return { path, cost: dist[to] };
}

/** POIs within N hops (graph distance, not AP). */
export function withinHops(content: Content, from: string, hops: number): Set<string> {
  const seen = new Set([from]);
  let frontier = [from];
  for (let i = 0; i < hops; i++) {
    const next: string[] = [];
    for (const n of frontier) for (const { to } of content.adjacency[n]) if (!seen.has(to)) (seen.add(to), next.push(to));
    frontier = next;
  }
  return seen;
}
