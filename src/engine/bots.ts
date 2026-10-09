import type { Content, GameState, Action, BotStrategy, Resources, PlayerState } from "../shared/types";
import { applyAction, checkAction, hubPois } from "./game";
import { currentPlayerId, shortestPath, hasTag, isClosed, pname } from "./helpers";
import { rand, pick, shuffle } from "./rng";

const W: Record<BotStrategy, Record<string, number>> = {
  random:     { explore: 1, invest: 1, work: 1, contest: 1, social: 1, intel: 1, crisis: 1 },
  greedy:     { explore: 0.8, invest: 1.6, work: 1.2, contest: 0.6, social: 0.6, intel: 0.6, crisis: 1 },
  explorer:   { explore: 2.0, invest: 0.7, work: 0.8, contest: 0.3, social: 0.8, intel: 1.0, crisis: 1 },
  trader:     { explore: 0.9, invest: 1.0, work: 1.0, contest: 0.3, social: 2.0, intel: 1.2, crisis: 1.2 },
  aggressive: { explore: 0.7, invest: 1.3, work: 0.9, contest: 2.2, social: 0.4, intel: 0.6, crisis: 0.8 },
};

export const BOT_STRATEGIES: BotStrategy[] = ["random", "greedy", "explorer", "trader", "aggressive"];
export const BOT_NAMES: Record<BotStrategy, string> = {
  random: "隨興阿伯", greedy: "精算師", explorer: "背包客", trader: "掮客", aggressive: "地頭蛇",
};

function value(r: Resources): number {
  return (r.money ?? 0) / 80 + (r.influence ?? 0) * 1.5 + (r.info ?? 0) * 0.9;
}

function strategyOf(p: PlayerState): BotStrategy {
  return p.botStrategy ?? "greedy";
}

/** Bots choose identity with a lean matching their strategy. */
export function botIdentity(content: Content, state: GameState, pid: string): Action {
  const p = state.players[pid];
  const lean: Record<BotStrategy, string[]> = {
    random: shuffle(state.rng, content.identities.map((i) => i.id)).slice(0, 2),
    greedy: ["commerce", "control"],
    explorer: ["explore", "intel"],
    trader: ["social", "commerce"],
    aggressive: ["control"],
  };
  const dirs = lean[strategyOf(p)];
  const ability = p.abilityOffer.find((a) => dirs.includes(content.abilityById[a].direction)) ?? p.abilityOffer[0];
  return {
    type: "SET_IDENTITY",
    directions: dirs,
    abilityId: ability,
    objectiveIds: p.objectiveOffer.slice(0, 2),
    startPoi: pick(state.rng, hubPois(content)).id,
  };
}

function candidates(content: Content, state: GameState, p: PlayerState): Action[] {
  const out: Action[] = [];
  if (p.position) {
    for (const { to } of content.adjacency[p.position]) out.push({ type: "MOVE", to });
    if (content.poiById[p.position].tags.includes("hub")) for (const h of hubPois(content)) if (h.id !== p.position) out.push({ type: "TRANSIT", to: h.id });
  }
  out.push({ type: "EXPLORE" }, { type: "INVESTIGATE" }, { type: "WORK" }, { type: "INVEST" }, { type: "BUILD" }, { type: "RESPOND_CRISIS" }, { type: "SELL_INFO" });
  out.push({ type: "CONTEST", infoSpend: Math.min(2, p.resources.info) });
  for (const c of state.contracts) if (c.status === "open") out.push({ type: "ACCEPT_CONTRACT", contractId: c.id });
  const strat = strategyOf(p);
  if ((strat === "trader" || strat === "random") && p.position) {
    for (const oid of state.playerOrder) {
      if (oid === p.id) continue;
      if (p.resources.info >= 2) out.push({ type: "TRADE_OFFER", to: oid, give: { info: 1 }, want: { money: 90 } });
      if (p.resources.money >= 300) out.push({ type: "TRADE_OFFER", to: oid, give: { money: 150 }, want: { influence: 1 } });
    }
    if (p.resources.money > 500) out.push({ type: "POST_CONTRACT", poiId: pick(state.rng, content.pois).id, reward: 80 });
  }
  return out;
}

/** Where does this bot want to be? */
function targetPoi(content: Content, state: GameState, p: PlayerState): string | null {
  const w = W[strategyOf(p)];
  let best: string | null = null;
  let bestScore = 0;
  for (const poi of content.pois) {
    if (poi.id === p.position) continue;
    const path = shortestPath(content, p.position!, poi.id);
    if (!path) continue;
    const s = state.pois[poi.id];
    let v = 0;
    if (!p.visited.includes(poi.id) && !isClosed(state, poi.id)) v += (3 + value(poi.explore)) * w.explore;
    if (poi.workPay > 0) v += (poi.workPay / 40) * w.work * (p.struggling ? 1.5 : 1);
    if (!s.owner && poi.investCost <= p.resources.money - 100) v += (2 + value(poi.income) * 2) * w.invest;
    if (s.owner && s.owner !== p.id && state.round > 2) v += 2.5 * w.contest;
    if (state.contracts.some((c) => c.acceptedBy === p.id && c.status === "accepted" && c.poiId === poi.id)) v += 9;
    if (state.crisis && !state.crisis.resolved) {
      const def = content.crises.find((c) => c.id === state.crisis!.crisisId)!;
      if (hasTag(poi, def.respondTags)) v += 4 * w.crisis;
    }
    const score = v / (1 + path.cost * 0.6);
    if (score > bestScore) (bestScore = score, (best = poi.id));
  }
  return best;
}

function scoreAction(content: Content, state: GameState, p: PlayerState, a: Action, target: string | null): number {
  const w = W[strategyOf(p)];
  const here = p.position ? content.poiById[p.position] : null;
  switch (a.type) {
    case "EXPLORE": return (6 + value(here!.explore) * 2) * w.explore;
    case "INVESTIGATE": return (1.5 + (hasTag(here!, "education|government|research") ? 1.5 : 0)) * w.intel;
    case "WORK": return (here!.workPay / 25) * w.work * (p.resources.money < 300 ? 1.6 : 1);
    case "INVEST": {
      const s = state.pois[here!.id];
      const taking = !s.owner || s.owner === p.id || (s.stakes[p.id] ?? 0) + 1 > (s.stakes[s.owner] ?? 0);
      const reserve = p.resources.money - here!.investCost < 120 ? -4 : 0;
      // already in control: extra stakes only matter as defence, so value them less the bigger the lead
      const others = Math.max(0, ...Object.entries(s.stakes).filter(([id]) => id !== p.id).map(([, v]) => v));
      const lead = s.owner === p.id ? (s.stakes[p.id] ?? 0) - others : 0;
      const stacking = lead >= 2 ? -6 : lead === 1 ? -2 : 0;
      return (4 + value(here!.income) * 2.5 + (taking ? 3 : -1) + reserve + stacking) * w.invest;
    }
    case "BUILD": return (p.resources.money > 500 ? 5 : 2) * w.invest;
    case "CONTEST": return 6 * w.contest;
    case "RESPOND_CRISIS": {
      const c = state.crisis!;
      const total = Object.values(c.contributions).reduce((x, y) => x + y, 0);
      return (total < c.target ? 8 : 3) * w.crisis;
    }
    case "SELL_INFO": return p.resources.money < 250 ? 5 : 0.5;
    case "ACCEPT_CONTRACT": {
      const c = state.contracts.find((x) => x.id === a.contractId)!;
      const path = p.position ? shortestPath(content, p.position, c.poiId) : null;
      if (!path || path.cost > 5) return 0;
      return (value(c.reward) * 2 - path.cost * 0.5 + 2) * w.social;
    }
    case "TRADE_OFFER": return 2.5 * w.social;
    case "POST_CONTRACT": return 1.5 * w.social;
    case "MOVE": case "TRANSIT": {
      if (!target || !p.position) return 0.2;
      const from = shortestPath(content, p.position, target)?.cost ?? 99;
      const to = a.to === target ? 0 : shortestPath(content, a.to, target)?.cost ?? 99;
      return from > to ? 4 + (from - to) : 0;
    }
    default: return 0;
  }
}

/** Choose one action for a bot (or for an AFK player). Returns END_TURN when nothing is worth doing. */
export function chooseBotAction(content: Content, state: GameState, pid: string, strategy?: BotStrategy): Action {
  const p = state.players[pid];
  if (p.abilityOffer.length) {
    const lean = p.directions;
    return { type: "CHOOSE_ABILITY", abilityId: p.abilityOffer.find((a) => lean.includes(content.abilityById[a].direction)) ?? p.abilityOffer[0] };
  }
  const saved = p.botStrategy;
  if (strategy) p.botStrategy = strategy;
  try {
    const valid = candidates(content, state, p).filter((a) => checkAction(content, state, pid, a).ok);
    if (!valid.length) return { type: "END_TURN" };
    if (strategyOf(p) === "random") return rand(state.rng) < 0.12 ? { type: "END_TURN" } : pick(state.rng, valid);
    const target = targetPoi(content, state, p);
    let best: Action = { type: "END_TURN" };
    let bestScore = 1;
    for (const a of valid) {
      const s = scoreAction(content, state, p, a, target) + rand(state.rng) * 0.5;
      if (s > bestScore) (bestScore = s, (best = a));
    }
    return best;
  } finally {
    p.botStrategy = saved;
  }
}

/** Bots evaluate trade offers addressed to them. */
function respondTrades(content: Content, state: GameState, now: number) {
  for (const t of state.trades) {
    if (t.status !== "open") continue;
    const to = state.players[t.to];
    if (!to?.isBot) continue;
    const accept = value(t.give) >= value(t.want) * 0.95 && checkAction(content, state, to.id, { type: "TRADE_RESPOND", tradeId: t.id, accept: true }).ok;
    applyAction(content, state, to.id, { type: "TRADE_RESPOND", tradeId: t.id, accept }, { now, auto: true });
  }
}

/** Run a full turn for the current player using bot logic. */
export function autoPlayTurn(content: Content, state: GameState, pid: string, now: number, strategy?: BotStrategy) {
  for (let i = 0; i < 40; i++) {
    if (state.status !== "playing" || currentPlayerId(state) !== pid) return;
    respondTrades(content, state, now);
    const a = chooseBotAction(content, state, pid, strategy);
    const r = applyAction(content, state, pid, a, { now, auto: true });
    if (!r.ok || a.type === "END_TURN") {
      if (!r.ok || a.type !== "END_TURN") applyAction(content, state, pid, { type: "END_TURN" }, { now, auto: true });
      return;
    }
  }
  applyAction(content, state, pid, { type: "END_TURN" }, { now, auto: true });
}

/** Advance the game while bots need to act. Safe to call after every mutation. */
export function runBots(content: Content, state: GameState, now = Date.now()) {
  if (state.status === "identity") {
    for (const pid of state.playerOrder) {
      const p = state.players[pid];
      if (p.isBot && !p.identityDone) applyAction(content, state, pid, botIdentity(content, state, pid), { now, auto: true });
    }
  }
  respondTrades(content, state, now);
  for (let guard = 0; guard < 500; guard++) {
    const pid = currentPlayerId(state);
    if (!pid || !state.players[pid].isBot) break;
    autoPlayTurn(content, state, pid, now);
  }
  respondTrades(content, state, now);
}

/** AFK handling: if the human's turn timed out, AI takes this one turn. */
export function handleTimeout(content: Content, state: GameState, now = Date.now()): boolean {
  if (state.status === "identity") {
    const limit = state.settings.turnTimeoutSec * 1000;
    if (now - state.turnStartedAt < limit) return false;
    for (const pid of state.playerOrder) {
      const p = state.players[pid];
      if (!p.identityDone) {
        applyAction(content, state, pid, botIdentity(content, state, pid), { now, auto: true });
        p.autoPlayed = true;
      }
    }
    return true;
  }
  const pid = currentPlayerId(state);
  if (!pid || state.players[pid].isBot) return false;
  if (now - state.turnStartedAt < state.settings.turnTimeoutSec * 1000) return false;
  state.players[pid].autoPlayed = true;
  state.log.push({ t: now, round: state.round, kind: "system", text: `${pname(state, pid)} 超時，由 AI 代為行動`, playerId: pid });
  autoPlayTurn(content, state, pid, now, "greedy");
  runBots(content, state, now);
  return true;
}
