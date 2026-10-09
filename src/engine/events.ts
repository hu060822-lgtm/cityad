import type { Content, GameState, EventDef, EventInstance, EffectDef, Scope, CrisisDef } from "../shared/types";
import { pick, weightedPick, randInt, shuffle } from "./rng";
import { gain, log, matchesScope, nextId, resolveScope, fmtRes, pname } from "./helpers";
import { controlledPois, publicEstimate } from "./scoring";

function eligible(content: Content, state: GameState, round: number, def: EventDef): boolean {
  if (def.chainOnly) return false;
  if (def.minRound && round < def.minRound) return false;
  if (def.maxRound != null) {
    const max = def.maxRound < 0 ? state.settings.totalRounds + def.maxRound : def.maxRound;
    if (round > max) return false;
  }
  // avoid immediate repeats
  const recent = state.eventHistory.slice(-3).map((e) => e.eventId);
  if (recent.includes(def.id)) return false;
  // poi binding must be satisfiable
  if (def.bind?.poi && !content.pois.some((p) => matchesScope(p, { tag: def.bind!.poi!.tag }))) return false;
  return true;
}

export function leaderId(content: Content, state: GameState): string | null {
  let best: string | null = null;
  let bestV = -Infinity;
  for (const id of state.playerOrder) {
    const v = publicEstimate(content, state, id);
    if (v > bestV) (bestV = v, (best = id));
  }
  return best;
}

export function lowestId(content: Content, state: GameState): string | null {
  let best: string | null = null;
  let bestV = Infinity;
  for (const id of state.playerOrder) {
    const v = publicEstimate(content, state, id);
    if (v < bestV) (bestV = v, (best = id));
  }
  return best;
}

function renderText(content: Content, state: GameState, text: string, vars: Record<string, string>): string {
  return text
    .replace("{district}", content.districtById[vars.district]?.name ?? "")
    .replace("{poiDistrict}", content.districtById[vars.poiDistrict]?.name ?? "")
    .replace(/\{poi\}/g, content.poiById[vars.poi]?.name ?? "")
    .replace("{player}", vars.player ? pname(state, vars.player) : "領先者");
}

/** Roll (but don't apply) an event instance for a round. Scheduled chains take priority. */
export function rollEvent(content: Content, state: GameState, round: number): EventInstance {
  const scheduled = state.scheduled.find((s) => s.round === round);
  let def: EventDef;
  let vars: Record<string, string> = {};
  if (scheduled) {
    def = content.eventById[scheduled.eventId];
    vars = { ...scheduled.vars };
  } else {
    const pool = content.events.filter((e) => eligible(content, state, round, e));
    def = pool.length ? weightedPick(state.rng, pool, (e) => e.weight ?? 1) : content.events.find((e) => !e.chainOnly)!;
    if (def.bind?.district) vars.district = pick(state.rng, content.districts).id;
    if (def.bind?.poi) {
      const cands = content.pois.filter((p) => matchesScope(p, { tag: def.bind!.poi!.tag }));
      const poi = pick(state.rng, cands);
      vars.poi = poi.id;
      vars.poiDistrict = poi.district;
    }
  }
  // render now so players who peek see real names; leader-bound text is re-rendered on apply
  return { eventId: def.id, round, name: def.name, text: renderText(content, state, def.text, vars), vars, kind: def.kind };
}

/** Apply a rolled event: binds late vars (e.g. leader), runs effects, logs. */
export function applyEvent(content: Content, state: GameState, inst: EventInstance) {
  const def = content.eventById[inst.eventId];
  if (def.bind?.player === "leader") inst.vars.player = leaderId(content, state) ?? "";
  inst.text = renderText(content, state, def.text, inst.vars);
  state.scheduled = state.scheduled.filter((s) => !(s.round === inst.round && s.eventId === inst.eventId));
  for (const ef of def.effects) applyEffect(content, state, ef, inst.vars, def.name);
  state.currentEvents.push(inst);
  state.eventHistory.push(inst);
  log(state, "event", `【${inst.name}】${inst.text}`);
}

export function applyEffect(content: Content, state: GameState, ef: EffectDef, vars: Record<string, string>, source: string) {
  const r = state.round;
  switch (ef.type) {
    case "modifier":
      state.modifiers.push({
        id: nextId(state, "m"), source, key: ef.key, scope: resolveScope(ef.scope, vars),
        value: ef.value, resources: ef.resources, untilRound: r + ef.duration - 1,
      });
      break;
    case "close": {
      const scope = resolveScope(ef.scope, vars);
      for (const p of content.pois) if (matchesScope(p, scope)) state.pois[p.id].closedUntil = Math.max(state.pois[p.id].closedUntil, r + ef.duration - 1);
      break;
    }
    case "spotlight": {
      if (!vars.poi) break;
      const scope: Scope = { poi: vars.poi };
      const until = r + ef.duration - 1;
      state.modifiers.push({ id: nextId(state, "m"), source, key: "income_mult", scope, value: 2, untilRound: until });
      state.modifiers.push({ id: nextId(state, "m"), source, key: "work_pay_mult", scope, value: 2, untilRound: until });
      state.modifiers.push({ id: nextId(state, "m"), source, key: "explore_bonus", scope, resources: { money: 50, influence: 1 }, untilRound: until });
      break;
    }
    case "grant": {
      const leader = leaderId(content, state);
      const lowest = lowestId(content, state);
      const scope = resolveScope(ef.scope, vars);
      for (const id of state.playerOrder) {
        const p = state.players[id];
        const hit =
          ef.target === "all" ||
          (ef.target === "leader" && id === leader) ||
          (ef.target === "not_leader" && id !== leader) ||
          (ef.target === "struggling" && p.struggling) ||
          (ef.target === "lowest" && id === lowest && !p.struggling) ||
          (ef.target === "at_scope" && p.position != null && matchesScope(content.poiById[p.position], scope));
        if (hit) {
          gain(p, ef.resources);
          log(state, "event", `${p.name} ${fmtRes(ef.resources)}`, id);
        }
      }
      break;
    }
    case "upkeep": {
      const scope = resolveScope(ef.scope, vars);
      for (const id of state.playerOrder) {
        const n = controlledPois(state, id).filter((pid) => matchesScope(content.poiById[pid], scope)).length;
        if (n > 0) {
          gain(state.players[id], { money: -ef.money * n });
          log(state, "event", `${state.players[id].name} 支付 $${ef.money * n}`, id);
        }
      }
      break;
    }
    case "spawn_contract":
      for (let i = 0; i < ef.count; i++) spawnCityContract(content, state, false, resolveScope(ef.scope, vars));
      break;
    case "chain":
      state.scheduled.push({ eventId: ef.next, round: r + ef.delay, vars: { ...vars } });
      break;
    case "city":
      state.city[ef.stat] = (state.city[ef.stat] ?? 0) + ef.value;
      break;
    case "reveal_next":
      for (const id of state.playerOrder) state.players[id].peekRound = r;
      break;
  }
}

export function spawnCityContract(content: Content, state: GameState, underground: boolean, scope: Scope = {}) {
  const cands = content.pois.filter((p) => matchesScope(p, scope));
  const poi = pick(state.rng, cands.length ? cands : content.pois);
  const base = 60 + randInt(state.rng, 0, 4) * 20;
  const reward = underground
    ? { money: base + 120, influence: 1 }
    : pick(state.rng, [{ money: base }, { money: Math.round(base / 2), influence: 1 }, { money: Math.round(base / 2), info: 1 }]);
  state.contracts.push({
    id: nextId(state, "c"),
    poster: "city",
    poiId: poi.id,
    reward,
    acceptedBy: null,
    expiresRound: state.round + 2,
    underground,
    status: "open",
    note: underground ? "地下委託（僅限困境中的玩家）" : "市民委託",
  });
}

export function startCrisis(content: Content, state: GameState) {
  const def: CrisisDef = pick(state.rng, shuffle(state.rng, content.crises));
  const target = def.targetPerPlayer * state.playerOrder.length;
  state.crisis = { crisisId: def.id, startRound: state.round, target, contributions: {} };
  for (const ef of def.onStart) applyEffect(content, state, ef, {}, def.name);
  const inst: EventInstance = { eventId: def.id, round: state.round, name: def.name, text: `${def.text} 全城需要 ${target} 次貢獻。`, vars: {}, kind: "crisis" };
  state.currentEvents.push(inst);
  state.eventHistory.push(inst);
  log(state, "crisis", `⚠ 城市危機【${def.name}】${inst.text}`);
}

export function resolveCrisis(content: Content, state: GameState) {
  if (!state.crisis || state.crisis.resolved) return;
  const def = content.crises.find((c) => c.id === state.crisis!.crisisId)!;
  const total = Object.values(state.crisis.contributions).reduce((s, v) => s + v, 0);
  state.crisis.resolved = total >= state.crisis.target ? "success" : "failure";
  log(state, "crisis", `危機結算：${total}/${state.crisis.target}。${state.crisis.resolved === "success" ? def.success.text : def.failure.text}`);
}
