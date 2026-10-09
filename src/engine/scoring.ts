import type { Content, GameState, PlayerState, ScoreBreakdown, Condition, SynergyDef } from "../shared/types";
import { abilityEffects, hasTag, withinHops } from "./helpers";

export function controlledPois(state: GameState, pid: string): string[] {
  return Object.entries(state.pois).filter(([, s]) => s.owner === pid).map(([id]) => id);
}

export function controlledWithTag(content: Content, state: GameState, pid: string, tagExpr: string): number {
  return controlledPois(state, pid).filter((id) => hasTag(content.poiById[id], tagExpr)).length;
}

/** Try to satisfy each requirement with a distinct POI (small backtracking). */
function satisfies(content: Content, poiIds: string[], reqs: string[]): string[] | null {
  const used = new Set<string>();
  const chosen: string[] = [];
  const rec = (i: number): boolean => {
    if (i === reqs.length) return true;
    for (const id of poiIds) {
      if (used.has(id) || !hasTag(content.poiById[id], reqs[i])) continue;
      used.add(id);
      chosen.push(id);
      if (rec(i + 1)) return true;
      used.delete(id);
      chosen.pop();
    }
    return false;
  };
  return rec(0) ? chosen : null;
}

/**
 * A synergy forms when a player controls POIs satisfying all requirements,
 * all within 2 hops of one of them (geographic cluster).
 */
export function playerSynergies(content: Content, state: GameState, pid: string): { def: SynergyDef; pois: string[] }[] {
  const owned = controlledPois(state, pid);
  const out: { def: SynergyDef; pois: string[] }[] = [];
  for (const def of content.synergies) {
    for (const anchor of owned) {
      const near = withinHops(content, anchor, 2);
      const pool = owned.filter((id) => near.has(id));
      const got = satisfies(content, pool, def.requires);
      if (got) {
        out.push({ def, pois: got });
        break;
      }
    }
  }
  return out;
}

/** District dominance: at least 2 controlled POIs and strictly the most in that district. */
export function districtDominance(content: Content, state: GameState): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const d of content.districts) {
    const counts: Record<string, number> = {};
    for (const p of content.pois) {
      if (p.district !== d.id) continue;
      const o = state.pois[p.id]?.owner;
      if (o) counts[o] = (counts[o] ?? 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    out[d.id] = sorted.length && sorted[0][1] >= 2 && (sorted.length === 1 || sorted[0][1] > sorted[1][1]) ? sorted[0][0] : null;
  }
  return out;
}

export function districtsExplored(content: Content, p: PlayerState): number {
  return new Set(p.visited.map((id) => content.poiById[id]?.district)).size;
}

export function checkCondition(content: Content, state: GameState, p: PlayerState, c: Condition): boolean {
  let v = 0;
  switch (c.kind) {
    case "stat": v = p.stats[c.key!] ?? 0; break;
    case "resource": v = p.resources[c.key as "money"] ?? 0; break;
    case "control_tag": v = controlledWithTag(content, state, p.id, c.key!); break;
    case "control_count": v = controlledPois(state, p.id).length; break;
    case "synergies": v = playerSynergies(content, state, p.id).length; break;
    case "districts_explored": v = districtsExplored(content, p); break;
    case "tier_explored": v = p.visited.filter((id) => String(content.poiById[id]?.tier) === c.key).length; break;
    case "dominance": v = Object.values(districtDominance(content, state)).filter((o) => o === p.id).length; break;
    case "flag": v = p.flags[c.key!] ? 1 : 0; break;
  }
  return c.op === ">=" ? v >= c.value : v <= c.value;
}

export function objectiveProgress(content: Content, state: GameState, p: PlayerState): { id: string; done: boolean }[] {
  return p.objectives.map((id) => {
    const def = content.objectiveById[id];
    return { id, done: !!def && def.conditions.every((c) => checkCondition(content, state, p, c)) };
  });
}

function cityGoalValue(content: Content, state: GameState, p: PlayerState): { base: number; metric: number } {
  const goal = content.cityGoals.find((g) => g.id === state.cityGoalId);
  if (!goal) return { base: 0, metric: 0 };
  const s = goal.scoring;
  let count = 0;
  if (s.kind === "control_tag") count = controlledWithTag(content, state, p.id, s.key);
  else count = Math.floor((p.stats[s.key] ?? 0) / (s.every ?? 1));
  const metric = s.topStat ? p.stats[s.topStat] ?? 0 : s.topResource ? p.resources[s.topResource] : s.kind === "stat" ? p.stats[s.key] ?? 0 : count;
  return { base: count * s.vpEach, metric };
}

export function computeScore(content: Content, state: GameState, pid: string, final = false): ScoreBreakdown {
  const p = state.players[pid];
  const owned = controlledPois(state, pid);
  const control = owned.reduce((s, id) => s + 2 + (state.pois[id]?.level ?? 0), 0);
  const synergy = playerSynergies(content, state, pid).reduce((s, x) => s + x.def.vp, 0);
  const dominance = Object.values(districtDominance(content, state)).filter((o) => o === pid).length * 3;

  // city goal + top bonus
  const goal = content.cityGoals.find((g) => g.id === state.cityGoalId);
  const mine = cityGoalValue(content, state, p);
  let cityGoal = mine.base;
  if (goal && mine.metric > 0) {
    const others = state.playerOrder.filter((id) => id !== pid).map((id) => cityGoalValue(content, state, state.players[id]).metric);
    if (others.every((m) => mine.metric > m)) cityGoal += goal.scoring.topBonus;
  }

  // crisis
  let crisis = 0;
  if (state.crisis?.resolved) {
    const def = content.crises.find((c) => c.id === state.crisis!.crisisId)!;
    const contrib = state.crisis.contributions[pid] ?? 0;
    if (state.crisis.resolved === "success") {
      crisis += contrib * def.success.vpPerContribution;
      const max = Math.max(0, ...Object.values(state.crisis.contributions));
      if (contrib > 0 && contrib === max) crisis += def.success.topVP;
    } else crisis += def.failure.vp;
  }

  const progress = objectiveProgress(content, state, p);
  const completed = progress.filter((x) => x.done).map((x) => x.id);
  const objectives = completed.reduce((s, id) => s + content.objectiveById[id].vp, 0);

  let abilities = 0;
  for (const e of abilityEffects(content, p, "vp_per_stat")) abilities += Math.floor((p.stats[e.stat] ?? 0) / e.every) * e.vp;

  const assets = Math.floor(p.resources.money / 100);
  const influence = Math.floor(p.resources.influence / (content.rules.influencePerVP || 1));
  const exploration = Math.floor(p.visited.length / (content.rules.explorePerVP || 2));
  const total = assets + influence + control + exploration + synergy + dominance + cityGoal + crisis + objectives + abilities;
  void final;
  return { assets, influence, control, exploration, synergy, dominance, cityGoal, crisis, objectives, abilities, total, completedObjectives: completed };
}

/** Public estimate excludes hidden objectives (so it doesn't leak secrets). */
export function publicEstimate(content: Content, state: GameState, pid: string): number {
  const s = computeScore(content, state, pid);
  return s.total - s.objectives;
}
