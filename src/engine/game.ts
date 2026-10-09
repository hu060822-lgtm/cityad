import type {
  Content, GameState, PlayerState, Action, ActionResult, Resources, ActionType, BotStrategy, POIDef, CityStat,
} from "../shared/types";
import { newRng, shuffle, pick, randInt, rand } from "./rng";
import {
  addInto, gain, canAfford, pay, fmtRes, isEmpty, log, bump, pname, currentPlayerId, nextId, hasTag, matchesScope,
  modAdd, modMult, modResources, isClosed, abilityEffects, hasEffect, effectSum, effectMult, effectResources, actionBonus, apOverride,
} from "./helpers";
import { rollEvent, applyEvent, spawnCityContract, startCrisis, resolveCrisis, leaderId } from "./events";
import { controlledPois, playerSynergies, districtDominance, computeScore, publicEstimate } from "./scoring";
import { buildReport } from "./report";

export const PLAYER_COLORS = ["#D1495B", "#2E86AB", "#E8A33D", "#3C9D5D", "#8E5CC4", "#1B998B"];

const DIRECTION_OF: Partial<Record<ActionType, string>> = {
  MOVE: "explore", TRANSIT: "explore", EXPLORE: "explore",
  INVESTIGATE: "intel", SELL_INFO: "intel",
  WORK: "commerce", INVEST: "commerce",
  BUILD: "control", CONTEST: "control",
  TRADE_OFFER: "social", TRADE_RESPOND: "social", POST_CONTRACT: "social", ACCEPT_CONTRACT: "social", RESPOND_CRISIS: "social",
};

const CATEGORY_STAT: Record<string, CityStat> = {
  food: "commerce", shopping: "commerce", transport: "mobility", culture: "culture", religion: "culture",
  nature: "nature", tourism: "tourism", education: "knowledge", government: "order", entertainment: "tourism",
};

// ============================================================
// Lifecycle
// ============================================================

export function createGame(content: Content, opts: { id: string; code: string; seed?: number; now?: number; totalRounds?: number; debug?: boolean }): GameState {
  const now = opts.now ?? Date.now();
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const pois: GameState["pois"] = {};
  for (const p of content.pois) pois[p.id] = { stakes: {}, owner: null, level: 0, activity: 0, closedUntil: 0 };
  return {
    id: opts.id,
    code: opts.code,
    version: 1,
    createdAt: now,
    updatedAt: now,
    status: "lobby",
    hostId: "",
    settings: { totalRounds: opts.totalRounds ?? content.rules.defaultRounds, turnTimeoutSec: content.rules.turnTimeoutSec },
    round: 0,
    turnOrder: [],
    turnIndex: 0,
    turnStartedAt: now,
    players: {},
    playerOrder: [],
    pois,
    rng: newRng(seed),
    modifiers: [],
    currentEvents: [],
    nextEvent: null,
    scheduled: [],
    eventHistory: [],
    cityGoalId: "",
    crisisRound: 0,
    crisis: null,
    contracts: [],
    trades: [],
    city: { commerce: 0, culture: 0, mobility: 0, nature: 0, tourism: 0, knowledge: 0, order: 0 },
    log: [],
    actions: [],
    counters: { seq: 0, id: 0 },
    result: null,
    debug: !!opts.debug,
  };
}

export function addPlayer(content: Content, state: GameState, opts: { id: string; name: string; isBot?: boolean; botStrategy?: BotStrategy }): PlayerState {
  if (state.status !== "lobby") throw new Error("遊戲已開始，無法加入");
  if (state.playerOrder.length >= content.rules.maxPlayers) throw new Error(`最多 ${content.rules.maxPlayers} 位玩家`);
  const name = opts.name.trim().slice(0, 16) || `玩家${state.playerOrder.length + 1}`;
  const used = new Set(Object.values(state.players).map((p) => p.color));
  const player: PlayerState = {
    id: opts.id,
    name,
    color: PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0],
    isBot: !!opts.isBot,
    botStrategy: opts.botStrategy,
    position: null,
    ap: 0,
    resources: { money: 0, influence: 0, info: 0 },
    directions: [],
    abilities: [],
    objectives: [],
    identityDone: false,
    abilityOffer: [],
    objectiveOffer: [],
    visited: [],
    stats: {},
    flags: {},
    investedCategories: [],
    struggling: false,
    turn: { freeMoveUsed: false, investigated: [], worked: [] },
    peekRound: 0,
    directionActs: {},
  };
  state.players[player.id] = player;
  state.playerOrder.push(player.id);
  if (!state.hostId) state.hostId = player.id;
  log(state, "system", `${player.name} 加入了遊戲${player.isBot ? "（電腦）" : ""}`, player.id);
  touch(state);
  return player;
}

export function removePlayer(state: GameState, pid: string) {
  if (state.status !== "lobby") throw new Error("遊戲進行中無法離開");
  const p = state.players[pid];
  if (!p) return;
  delete state.players[pid];
  state.playerOrder = state.playerOrder.filter((id) => id !== pid);
  if (state.hostId === pid) state.hostId = state.playerOrder.find((id) => !state.players[id].isBot) ?? state.playerOrder[0] ?? "";
  log(state, "system", `${p.name} 離開了大廳`);
  touch(state);
}

export function setRounds(content: Content, state: GameState, rounds: number) {
  if (state.status !== "lobby") throw new Error("只能在大廳調整");
  if (!content.rules.roundOptions.includes(rounds)) throw new Error("不支援的回合數");
  state.settings.totalRounds = rounds;
  touch(state);
}

/** Lobby → Identity phase. Deals ability and objective offers. */
export function startGame(content: Content, state: GameState, now = Date.now()) {
  if (state.status !== "lobby") throw new Error("遊戲已開始");
  if (state.playerOrder.length < content.rules.minPlayers) throw new Error(`至少需要 ${content.rules.minPlayers} 位玩家（可以加入電腦玩家）`);
  const R = state.settings.totalRounds;
  state.cityGoalId = pick(state.rng, content.cityGoals).id;
  state.crisisRound = Math.max(3, R - content.rules.finaleRounds);
  state.status = "identity";

  const objectivePool = shuffle(state.rng, content.objectives.map((o) => o.id));
  let oi = 0;
  for (const pid of state.playerOrder) {
    const p = state.players[pid];
    p.abilityOffer = dealAbilities(content, state, [], 4, null);
    p.objectiveOffer = [];
    while (p.objectiveOffer.length < 3) p.objectiveOffer.push(objectivePool[oi++ % objectivePool.length]);
    p.objectiveOffer = [...new Set(p.objectiveOffer)];
  }
  const goal = content.cityGoals.find((g) => g.id === state.cityGoalId)!;
  log(state, "system", `本局城市目標：【${goal.name}】${goal.description}`);
  log(state, "system", `共 ${R} 回合，第 ${state.crisisRound} 回合將爆發城市危機。`);
  state.turnStartedAt = now;
  touch(state);
}

/** Deal N abilities the player doesn't own, preferring distinct directions (or weighted toward `favor`). */
function dealAbilities(content: Content, state: GameState, owned: string[], n: number, favor: string[] | null): string[] {
  const pool = shuffle(state.rng, content.abilities.filter((a) => !owned.includes(a.id)));
  const out: string[] = [];
  const dirs = new Set<string>();
  if (favor) for (const d of favor) {
    const a = pool.find((x) => x.direction === d && !out.includes(x.id));
    if (a && out.length < n) out.push(a.id);
  }
  for (const a of pool) {
    if (out.length >= n) break;
    if (out.includes(a.id) || dirs.has(a.direction)) continue;
    out.push(a.id);
    dirs.add(a.direction);
  }
  for (const a of pool) if (out.length < n && !out.includes(a.id)) out.push(a.id);
  return out;
}

export function hubPois(content: Content): POIDef[] {
  return content.pois.filter((p) => p.tags.includes("hub"));
}

// ============================================================
// Rounds & turns
// ============================================================

function beginRound(content: Content, state: GameState, round: number, now: number) {
  const R = state.settings.totalRounds;
  if (round > R) return finishGame(content, state);
  const rules = content.rules;
  state.round = round;
  state.currentEvents = [];
  state.modifiers = state.modifiers.filter((m) => m.untilRound >= round);
  log(state, "turn", `—— 第 ${round} 回合開始 ——`);

  // expire trades & contracts
  for (const t of state.trades) if (t.status === "open" && t.round < round) {
    t.status = "expired";
    gain(state.players[t.from], t.give);
  }
  for (const c of state.contracts) if ((c.status === "open" || c.status === "accepted") && c.expiresRound < round) {
    c.status = "expired";
    if (c.poster !== "city") gain(state.players[c.poster], c.reward);
  }
  state.trades = state.trades.filter((t) => t.status === "open" || t.round >= round - 1);
  state.contracts = state.contracts.filter((c) => c.status === "open" || c.status === "accepted" || c.expiresRound >= round - 1);

  // crisis
  if (round === state.crisisRound && !state.crisis) startCrisis(content, state);

  // event
  const inst = state.nextEvent && state.nextEvent.round === round ? state.nextEvent : rollEvent(content, state, round);
  state.nextEvent = null;
  applyEvent(content, state, inst);

  // income phase
  const income: Record<string, Resources> = {};
  for (const poi of content.pois) {
    const s = state.pois[poi.id];
    if (!s.owner) continue;
    const owner = state.players[s.owner];
    const mult = (1 + 0.5 * s.level) * modMult(state, "income_mult", poi) * effectMult(content, owner, "income_mult");
    addInto((income[s.owner] ??= {}), poi.income, mult);
  }
  for (const pid of state.playerOrder) {
    for (const syn of playerSynergies(content, state, pid)) addInto((income[pid] ??= {}), syn.def.perRound);
  }
  const dom = districtDominance(content, state);
  for (const [did, owner] of Object.entries(dom)) if (owner) addInto((income[owner] ??= {}), content.districtById[did].dominanceBonus);
  for (const [pid, res] of Object.entries(income)) {
    gain(state.players[pid], res);
    log(state, "system", `${state.players[pid].name} 城市收益 ${fmtRes(res)}`, pid);
  }

  // upkeep & leader burden
  for (const pid of state.playerOrder) {
    const p = state.players[pid];
    const n = controlledPois(state, pid).length;
    let upkeep = Math.max(0, n - rules.controlUpkeepFree) * rules.controlUpkeepPerExtra + effectSum(content, p, "upkeep_money");
    if (upkeep > 0) {
      upkeep = Math.min(upkeep, p.resources.money);
      p.resources.money -= upkeep;
      if (upkeep) log(state, "system", `${p.name} 支付維護費 $${upkeep}`, pid);
    }
  }

  // struggling state (catch-up)
  let anyStruggling = false;
  for (const pid of state.playerOrder) {
    const p = state.players[pid];
    const was = p.struggling;
    p.struggling = p.resources.money < rules.struggleThreshold;
    if (p.struggling) {
      anyStruggling = true;
      p.flags.everStruggled = true;
      gain(p, { info: 1 });
      if (!was) log(state, "system", `${p.name} 陷入困境：打工收入 +50%、可出售情報、可接地下委託，每回合 +1 情報。`, pid);
    }
    if (p.flags.everStruggled && p.resources.money >= rules.recoverThreshold && !p.flags.recovered) {
      p.flags.recovered = true;
      log(state, "system", `${p.name} 從困境中翻身！`, pid);
    }
  }

  // city contracts
  for (let i = 0; i < rules.npcContractsPerRound; i++) spawnCityContract(content, state, false);
  if (anyStruggling) spawnCityContract(content, state, true);

  // ability drafts — identity grows from what you actually do
  if (rules.abilityDraftRounds.includes(round)) {
    for (const pid of state.playerOrder) {
      const p = state.players[pid];
      const favor = Object.entries(p.directionActs).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([d]) => d);
      p.abilityOffer = dealAbilities(content, state, p.abilities, 3, favor.length ? favor : p.directions);
      log(state, "system", `${p.name} 獲得一次能力選擇`, pid);
    }
  }

  // turn order: trailing players act first (soft catch-up)
  const rot = (round - 1) % state.playerOrder.length;
  const rotated = [...state.playerOrder.slice(rot), ...state.playerOrder.slice(0, rot)];
  state.turnOrder = rotated
    .map((id, i) => ({ id, i, v: publicEstimate(content, state, id) }))
    .sort((a, b) => a.v - b.v || a.i - b.i)
    .map((x) => x.id);

  // pre-roll next event so intel players can peek
  if (round + 1 <= R) state.nextEvent = rollEvent(content, state, round + 1);

  state.turnIndex = 0;
  beginTurn(content, state, now);
}

function beginTurn(content: Content, state: GameState, now: number) {
  const pid = currentPlayerId(state);
  if (!pid) return;
  const p = state.players[pid];
  p.ap = content.rules.baseAP + effectSum(content, p, "ap_bonus");
  p.turn = { freeMoveUsed: false, investigated: [], worked: [] };
  if (hasEffect(content, p, "see_next_event")) p.peekRound = state.round;
  state.turnStartedAt = now;
  log(state, "turn", `輪到 ${p.name}（${p.ap} AP）`, pid);
}

function endTurn(content: Content, state: GameState, now: number) {
  state.turnIndex += 1;
  if (state.turnIndex >= state.turnOrder.length) beginRound(content, state, state.round + 1, now);
  else beginTurn(content, state, now);
}

function finishGame(content: Content, state: GameState) {
  resolveCrisis(content, state);
  state.status = "finished";
  const scores: Record<string, ReturnType<typeof computeScore>> = {};
  for (const id of state.playerOrder) scores[id] = computeScore(content, state, id, true);
  const ranking = [...state.playerOrder].sort((a, b) => scores[b].total - scores[a].total || state.players[b].resources.money - state.players[a].resources.money);
  const top = scores[ranking[0]].total;
  const winners = ranking.filter((id) => scores[id].total === top);
  state.result = { scores, ranking, winners, report: { headline: "", playerLines: [], districtLines: [], highlights: [], achievements: [] } };
  state.result.report = buildReport(content, state);
  log(state, "system", `遊戲結束！勝者：${winners.map((w) => state.players[w].name).join("、")}（${top} 分）`);
}

// ============================================================
// Actions — each planner validates and returns an executor
// ============================================================

type Plan = { error: string } | { ap: number; cost?: Resources; run: () => string };

function apCost(content: Content, state: GameState, p: PlayerState, type: ActionType): number {
  const o = apOverride(content, p, type);
  if (o != null) return o;
  let base = content.rules.apCost[type] ?? 0;
  if (type === "TRANSIT") {
    const here = p.position ? state.pois[p.position] : null;
    if (here?.owner === p.id) base = 1;
    base = Math.max(1, base + modAdd(state, "transit_ap_add", null));
  }
  return base;
}

export function moveCost(content: Content, state: GameState, p: PlayerState, to: string): number | null {
  if (!p.position) return null;
  const link = content.adjacency[p.position].find((a) => a.to === to);
  if (!link) return null;
  let cost = link.edge.cost ?? 1;
  for (const cap of abilityEffects(content, p, "edge_cost_cap")) cost = Math.min(cost, cap.value);
  cost += Math.max(modAdd(state, "move_cost_add", content.poiById[p.position]), modAdd(state, "move_cost_add", content.poiById[to]));
  if (hasEffect(content, p, "free_move_visited") && !p.turn.freeMoveUsed && p.visited.includes(to)) return 0;
  return Math.max(1, cost);
}

export function investCost(content: Content, state: GameState, p: PlayerState, poi: POIDef): number {
  let c = poi.investCost * modMult(state, "invest_cost_mult", poi) * effectMult(content, p, "invest_cost_mult");
  if (state.status === "playing" && leaderId(content, state) === p.id && state.round >= 3) c *= 1 + content.rules.leaderInvestSurcharge;
  return Math.round(c / 10) * 10;
}

export function buildCost(content: Content, state: GameState, p: PlayerState, poi: POIDef): number {
  const lvl = state.pois[poi.id].level;
  const c = poi.investCost * content.rules.buildCostFactor * (lvl + 1) * modMult(state, "invest_cost_mult", poi) * effectMult(content, p, "build_cost_mult");
  return Math.round(c / 10) * 10;
}

export function workPay(content: Content, state: GameState, p: PlayerState, poi: POIDef): number {
  let pay = poi.workPay * modMult(state, "work_pay_mult", poi) * effectMult(content, p, "work_pay_mult");
  if (p.struggling) pay *= 1.5;
  return Math.round(pay / 5) * 5;
}

function contestStrength(content: Content, state: GameState, attacker: PlayerState, poi: POIDef, infoSpend: number) {
  const s = state.pois[poi.id];
  const owner = s.owner ? state.players[s.owner] : null;
  const atk = (s.stakes[attacker.id] ?? 0) + Math.floor(attacker.resources.influence / 3) + effectSum(content, attacker, "contest_bonus") + infoSpend;
  const def = (owner ? s.stakes[owner.id] ?? 0 : 0) + poi.defense + s.level + (owner ? effectSum(content, owner, "defense_bonus") : 0);
  return { atk, def };
}

function recomputeOwner(state: GameState, poiId: string) {
  const s = state.pois[poiId];
  const entries = Object.entries(s.stakes).filter(([, v]) => v > 0);
  s.stakes = Object.fromEntries(entries);
  if (!entries.length) {
    s.owner = null;
    s.level = 0;
    return;
  }
  const max = Math.max(...entries.map(([, v]) => v));
  if (s.owner && (s.stakes[s.owner] ?? 0) === max) return; // incumbent keeps ties
  s.owner = entries.find(([, v]) => v === max)![0];
}

function cityStat(state: GameState, poi: POIDef, by: number) {
  const k = CATEGORY_STAT[poi.category];
  if (k) state.city[k] += by;
}

function completeContracts(content: Content, state: GameState, p: PlayerState, poiId: string): string[] {
  const msgs: string[] = [];
  for (const c of state.contracts) {
    if (c.status !== "accepted" || c.acceptedBy !== p.id || c.poiId !== poiId) continue;
    c.status = "done";
    const reward: Resources = { ...c.reward };
    addInto(reward, effectResources(content, p, "contract_bonus"));
    gain(p, reward);
    bump(p, "contractsCompleted");
    msgs.push(`完成委託（${content.poiById[poiId].name}），獲得 ${fmtRes(reward)}`);
    if (c.poster !== "city") {
      const poster = state.players[c.poster];
      const back: Resources = { info: 1, influence: 1 };
      addInto(back, effectResources(content, poster, "contract_bonus"));
      gain(poster, back);
      bump(poster, "contractsFulfilledForMe");
      log(state, "action", `${poster.name} 的委託由 ${p.name} 完成，回報 ${fmtRes(back)}`, poster.id);
    }
  }
  return msgs;
}

function planAction(content: Content, state: GameState, p: PlayerState, a: Action): Plan {
  const rules = content.rules;
  const here = p.position ? content.poiById[p.position] : null;
  const hereState = p.position ? state.pois[p.position] : null;
  const needHere = (): Plan | null => (here ? null : { error: "你不在任何地點" });
  const needOpen = (): Plan | null => (here && isClosed(state, here.id) ? { error: `${here.name} 暫停開放` } : null);

  switch (a.type) {
    case "MOVE": {
      const to = content.poiById[a.to];
      if (!to) return { error: "未知地點" };
      const cost = moveCost(content, state, p, a.to);
      if (cost == null) return { error: "只能移動到相鄰地點" };
      return {
        ap: cost,
        run: () => {
          if (cost === 0) p.turn.freeMoveUsed = true;
          p.position = a.to;
          bump(p, "moves");
          state.pois[a.to].activity += 1;
          return `移動到 ${to.name}${cost === 0 ? "（熟門熟路，免費）" : ""}`;
        },
      };
    }
    case "TRANSIT": {
      const e = needHere(); if (e) return e;
      const to = content.poiById[a.to];
      if (!here!.tags.includes("hub")) return { error: "只能在交通樞紐轉乘" };
      if (!to?.tags.includes("hub") || to.id === here!.id) return { error: "目的地必須是其他交通樞紐" };
      return { ap: apCost(content, state, p, "TRANSIT"), run: () => {
        p.position = to.id;
        bump(p, "transits");
        cityStat(state, to, 1);
        return `從 ${here!.name} 轉乘到 ${to.name}`;
      } };
    }
    case "EXPLORE": {
      const e = needHere() ?? needOpen(); if (e) return e;
      if (p.visited.includes(here!.id)) return { error: "你已經探索過這裡" };
      return { ap: apCost(content, state, p, "EXPLORE"), run: () => {
        const r: Resources = { ...here!.explore };
        addInto(r, modResources(state, "explore_bonus", here!));
        addInto(r, effectResources(content, p, "explore_bonus"));
        gain(p, r);
        p.visited.push(here!.id);
        bump(p, "explored");
        cityStat(state, here!, 1);
        hereState!.activity += 1;
        const extra = completeContracts(content, state, p, here!.id);
        return [`探索了 ${here!.name}，獲得 ${fmtRes(r)}`, ...extra].join("；");
      } };
    }
    case "INVESTIGATE": {
      const e = needHere(); if (e) return e;
      if (p.turn.investigated.includes(here!.id)) return { error: "本回合已調查過這裡" };
      return { ap: apCost(content, state, p, "INVESTIGATE"), run: () => {
        const r: Resources = { info: 1 };
        if (hasTag(here!, "education|government|research")) r.info! += 1;
        addInto(r, actionBonus(content, p, "INVESTIGATE"));
        addInto(r, modResources(state, "investigate_bonus", here!));
        gain(p, r);
        p.turn.investigated.push(here!.id);
        p.peekRound = state.round;
        bump(p, "investigations");
        const extra = completeContracts(content, state, p, here!.id);
        return [`調查了 ${here!.name}，獲得 ${fmtRes(r)}，並得知下一回合的事件`, ...extra].join("；");
      } };
    }
    case "WORK": {
      const e = needHere() ?? needOpen(); if (e) return e;
      if (here!.workPay <= 0) return { error: "這裡沒有打工機會" };
      if (p.turn.worked.includes(here!.id)) return { error: "本回合已在這裡打工" };
      const payAmt = workPay(content, state, p, here!);
      if (payAmt <= 0) return { error: "目前無法打工（事件影響）" };
      return { ap: apCost(content, state, p, "WORK"), run: () => {
        gain(p, { money: payAmt });
        p.turn.worked.push(here!.id);
        bump(p, "works");
        hereState!.activity += 1;
        return `在 ${here!.name} 打工，賺到 $${payAmt}`;
      } };
    }
    case "INVEST": {
      const e = needHere() ?? needOpen(); if (e) return e;
      const s = hereState!;
      const total = Object.values(s.stakes).reduce((x, y) => x + y, 0);
      if (total >= rules.maxStakesPerPoi) return { error: "這裡的投資額度已滿，只能爭奪" };
      const cost = investCost(content, state, p, here!);
      return { ap: apCost(content, state, p, "INVEST"), cost: { money: cost }, run: () => {
        s.stakes[p.id] = (s.stakes[p.id] ?? 0) + 1;
        const before = s.owner;
        recomputeOwner(state, here!.id);
        bump(p, "invests");
        cityStat(state, here!, 2);
        let refund = 0;
        if (!p.investedCategories.includes(here!.category)) {
          p.investedCategories.push(here!.category);
          refund = abilityEffects(content, p, "first_invest_category_refund").reduce((x, y) => x + y.money, 0);
          if (refund) gain(p, { money: refund });
        }
        const took = s.owner === p.id && before !== p.id;
        return `投資 ${here!.name}（$${cost}${refund ? `，退回 $${refund}` : ""}），持股 ${s.stakes[p.id]}${took ? "，取得控制權" : ""}`;
      } };
    }
    case "BUILD": {
      const e = needHere() ?? needOpen(); if (e) return e;
      if (hereState!.owner !== p.id) return { error: "只能建設你控制的地點" };
      if (hereState!.level >= rules.maxLevel) return { error: "已達最高等級" };
      const cost = buildCost(content, state, p, here!);
      return { ap: apCost(content, state, p, "BUILD"), cost: { money: cost }, run: () => {
        hereState!.level += 1;
        bump(p, "builds");
        cityStat(state, here!, 3);
        return `建設 ${here!.name} 到 Lv.${hereState!.level}（$${cost}）`;
      } };
    }
    case "CONTEST": {
      const e = needHere(); if (e) return e;
      if (state.round <= rules.openingRounds) return { error: `第 ${rules.openingRounds + 1} 回合起才能爭奪` };
      const s = hereState!;
      if (!s.owner || s.owner === p.id) return { error: "只能爭奪其他玩家控制的地點" };
      const infoSpend = Math.max(0, Math.min(rules.contestMaxInfoSpend, Math.floor(a.infoSpend ?? 0)));
      const cost: Resources = { influence: rules.contestInfluenceCost, info: infoSpend };
      return { ap: apCost(content, state, p, "CONTEST"), cost, run: () => {
        const owner = state.players[s.owner!];
        const { atk, def } = contestStrength(content, state, p, here!, infoSpend);
        const ra = randInt(state.rng, 1, 6);
        const rd = randInt(state.rng, 1, 6);
        bump(p, "contestsStarted");
        const win = atk + ra > def + rd;
        let msg: string;
        if (win) {
          const margin = atk + ra - (def + rd);
          const take = Math.min(margin >= 3 ? 2 : 1, s.stakes[owner.id] ?? 0);
          s.stakes[owner.id] = (s.stakes[owner.id] ?? 0) - take;
          s.stakes[p.id] = (s.stakes[p.id] ?? 0) + take;
          if (s.level > 0 && margin >= 3) s.level -= 1;
          recomputeOwner(state, here!.id);
          gain(p, { influence: 1 });
          gain(owner, { influence: -1 });
          bump(p, "contestsWon");
          msg = `爭奪 ${here!.name} 成功！（${atk}+🎲${ra} 對 ${def}+🎲${rd}）奪得 ${take} 股${s.owner === p.id ? "，取得控制權" : ""}`;
        } else {
          gain(p, { influence: -1 });
          bump(owner, "defenses");
          msg = `爭奪 ${here!.name} 失敗（${atk}+🎲${ra} 對 ${def}+🎲${rd}），${owner.name} 守住了`;
        }
        log(state, "contest", `${p.name} ${msg}`, p.id);
        return msg;
      } };
    }
    case "TRADE_OFFER": {
      const to = state.players[a.to];
      if (!to || to.id === p.id) return { error: "交易對象無效" };
      const give = sanitize(a.give);
      const want = sanitize(a.want);
      if (isEmpty(give) && isEmpty(want)) return { error: "交易內容不能是空的" };
      const anywhere = hasEffect(content, p, "trade_anywhere");
      const sameDistrict = p.position && to.position && content.poiById[p.position].district === content.poiById[to.position].district;
      const atHub = here?.tags.includes("hub");
      if (!anywhere && !sameDistrict && !atHub) return { error: "需要和對方在同一地區，或你在交通樞紐" };
      if (state.trades.filter((t) => t.from === p.id && t.status === "open").length >= 2) return { error: "最多同時 2 筆交易提案" };
      return { ap: apCost(content, state, p, "TRADE_OFFER"), cost: give, run: () => {
        const t = { id: nextId(state, "t"), from: p.id, to: to.id, give, want, round: state.round, status: "open" as const };
        state.trades.push(t);
        log(state, "trade", `${p.name} 向 ${to.name} 提出交易：給 ${fmtRes(give)}，換 ${fmtRes(want)}`, p.id);
        return `向 ${to.name} 提出交易`;
      } };
    }
    case "TRADE_RESPOND": {
      const t = state.trades.find((x) => x.id === a.tradeId);
      if (!t || t.status !== "open" || t.to !== p.id) return { error: "找不到這筆交易" };
      if (a.accept && !canAfford(p, t.want)) return { error: "你付不出對方要的資源" };
      return { ap: 0, run: () => {
        const from = state.players[t.from];
        if (!a.accept) {
          t.status = "declined";
          gain(from, t.give);
          log(state, "trade", `${p.name} 拒絕了 ${from.name} 的交易`, p.id);
          return "拒絕交易";
        }
        t.status = "accepted";
        pay(p, t.want);
        gain(from, t.want);
        gain(p, t.give);
        for (const who of [p, from]) {
          bump(who, "trades");
          const bonus = effectResources(content, who, "trade_bonus");
          if (!isEmpty(bonus)) gain(who, bonus);
        }
        bump(from, "tradeValue", (t.give.money ?? 0) + (t.want.money ?? 0));
        log(state, "trade", `${p.name} 接受了 ${from.name} 的交易：${fmtRes(t.give)} ⇄ ${fmtRes(t.want)}`, p.id);
        return "完成交易";
      } };
    }
    case "TRADE_CANCEL": {
      const t = state.trades.find((x) => x.id === a.tradeId);
      if (!t || t.status !== "open" || t.from !== p.id) return { error: "找不到這筆交易" };
      return { ap: 0, run: () => {
        t.status = "cancelled";
        gain(p, t.give);
        return "撤回交易";
      } };
    }
    case "POST_CONTRACT": {
      const poi = content.poiById[a.poiId];
      if (!poi) return { error: "未知地點" };
      const reward = Math.floor(a.reward);
      if (!(reward >= rules.contractMinReward)) return { error: `報酬至少 $${rules.contractMinReward}` };
      if (state.contracts.filter((c) => c.poster === p.id && (c.status === "open" || c.status === "accepted")).length >= 2) return { error: "最多同時 2 個委託" };
      return { ap: apCost(content, state, p, "POST_CONTRACT"), cost: { money: reward }, run: () => {
        state.contracts.push({ id: nextId(state, "c"), poster: p.id, poiId: poi.id, reward: { money: reward }, acceptedBy: null, expiresRound: state.round + rules.contractDuration, status: "open" });
        bump(p, "contractsPosted");
        log(state, "action", `${p.name} 發布委託：前往 ${poi.name} 探索或調查，報酬 $${reward}`, p.id);
        return `發布委託（${poi.name}，$${reward}）`;
      } };
    }
    case "ACCEPT_CONTRACT": {
      const c = state.contracts.find((x) => x.id === a.contractId);
      if (!c || c.status !== "open") return { error: "委託已被接走或過期" };
      if (c.poster === p.id) return { error: "不能接自己的委託" };
      if (c.underground && !p.struggling) return { error: "地下委託只有困境中的玩家能接" };
      if (state.contracts.filter((x) => x.acceptedBy === p.id && x.status === "accepted").length >= 2) return { error: "最多同時接 2 個委託" };
      return { ap: apCost(content, state, p, "ACCEPT_CONTRACT"), run: () => {
        c.status = "accepted";
        c.acceptedBy = p.id;
        log(state, "action", `${p.name} 接下委託：${content.poiById[c.poiId].name}（委託人 ${pname(state, c.poster)}）`, p.id);
        return `接下委託：${content.poiById[c.poiId].name}`;
      } };
    }
    case "RESPOND_CRISIS": {
      const e = needHere(); if (e) return e;
      if (!state.crisis || state.crisis.resolved) return { error: "目前沒有城市危機" };
      const def = content.crises.find((c) => c.id === state.crisis!.crisisId)!;
      if (!hasTag(here!, def.respondTags)) return { error: `要在符合條件的地點回應（${def.respondTags.replace(/\|/g, "／")}）` };
      return { ap: apCost(content, state, p, "RESPOND_CRISIS"), cost: def.respondCost, run: () => {
        const mult = abilityEffects(content, p, "crisis_multiplier").reduce((x, y) => Math.max(x, y.value), 1);
        state.crisis!.contributions[p.id] = (state.crisis!.contributions[p.id] ?? 0) + mult;
        bump(p, "crisisContribution", mult);
        state.city.order += 1;
        const total = Object.values(state.crisis!.contributions).reduce((x, y) => x + y, 0);
        log(state, "crisis", `${p.name} 在 ${here!.name} 回應危機（${total}/${state.crisis!.target}）`, p.id);
        return `回應危機 +${mult}`;
      } };
    }
    case "SELL_INFO": {
      if (!p.struggling && !hasEffect(content, p, "can_sell_info")) return { error: "只有困境中或有「情報販子」能力的玩家能出售情報" };
      const price = rules.sellInfoPrice + abilityEffects(content, p, "sell_info_bonus").reduce((x, y) => x + y.money, 0);
      return { ap: apCost(content, state, p, "SELL_INFO"), cost: { info: 1 }, run: () => {
        gain(p, { money: price });
        bump(p, "infoSold");
        return `出售 1 情報，得到 $${price}`;
      } };
    }
    default:
      return { error: "未知行動" };
  }
}

function sanitize(r: Resources | undefined): Resources {
  const out: Resources = {};
  if (!r) return out;
  for (const k of ["money", "influence", "info"] as const) {
    const v = Math.floor(Number(r[k] ?? 0));
    if (v > 0) out[k] = Math.min(v, 100000);
  }
  return out;
}

/** Check an action without applying it. */
export function checkAction(content: Content, state: GameState, pid: string, a: Action): { ok: boolean; error?: string; ap?: number; cost?: Resources } {
  const pre = preconditions(content, state, pid, a);
  if (pre) return { ok: false, error: pre };
  const p = state.players[pid];
  const plan = planAction(content, state, p, a);
  if ("error" in plan) return { ok: false, error: plan.error };
  if (plan.ap > p.ap) return { ok: false, error: `AP 不足（需要 ${plan.ap}）`, ap: plan.ap, cost: plan.cost };
  if (plan.cost && !canAfford(p, plan.cost)) return { ok: false, error: `資源不足（需要 ${fmtRes(plan.cost).replace(/\+/g, "")}）`, ap: plan.ap, cost: plan.cost };
  return { ok: true, ap: plan.ap, cost: plan.cost };
}

const OFF_TURN_OK: ActionType[] = ["TRADE_RESPOND", "TRADE_CANCEL", "CHOOSE_ABILITY"];

function preconditions(content: Content, state: GameState, pid: string, a: Action): string | null {
  const p = state.players[pid];
  if (!p) return "你不在這場遊戲中";
  if (a.type === "SET_IDENTITY") return state.status === "identity" ? null : "現在不是建立身份階段";
  if (state.status !== "playing") return "遊戲尚未進行中";
  if (a.type === "CHOOSE_ABILITY") return p.abilityOffer.length ? null : "目前沒有能力可選";
  if (!OFF_TURN_OK.includes(a.type) && currentPlayerId(state) !== pid) return "還沒輪到你";
  if (p.abilityOffer.length && a.type !== "END_TURN" && !OFF_TURN_OK.includes(a.type)) return "請先選擇新能力";
  void content;
  return null;
}

/** Apply an action. The single entry point for all player-driven state changes. */
export function applyAction(content: Content, state: GameState, pid: string, a: Action, opts: { now?: number; auto?: boolean } = {}): ActionResult {
  const now = opts.now ?? Date.now();
  const pre = preconditions(content, state, pid, a);
  const record = (ok: boolean) => {
    state.counters.seq += 1;
    state.actions.push({ seq: state.counters.seq, t: now, round: state.round, playerId: pid, action: a, ok, auto: opts.auto });
  };
  if (pre) return { ok: false, error: pre, messages: [] };
  const p = state.players[pid];

  if (a.type === "SET_IDENTITY") {
    const err = setIdentity(content, state, p, a);
    if (err) return { ok: false, error: err, messages: [] };
    record(true);
    if (state.playerOrder.every((id) => state.players[id].identityDone)) {
      state.status = "playing";
      beginRound(content, state, 1, now);
    }
    touch(state);
    return { ok: true, messages: ["身份建立完成"] };
  }

  if (a.type === "CHOOSE_ABILITY") {
    if (!p.abilityOffer.includes(a.abilityId)) return { ok: false, error: "不在可選能力中", messages: [] };
    p.abilities.push(a.abilityId);
    p.abilityOffer = [];
    record(true);
    const def = content.abilityById[a.abilityId];
    log(state, "action", `${p.name} 習得能力【${def.name}】`, pid);
    // an ability that grants AP applies immediately if it's their turn
    if (currentPlayerId(state) === pid) for (const e of def.effects) if (e.type === "ap_bonus") p.ap += e.value;
    touch(state);
    return { ok: true, messages: [`習得【${def.name}】`] };
  }

  if (a.type === "END_TURN") {
    if (p.abilityOffer.length) {
      // auto-pick first offered ability so the game never stalls
      p.abilities.push(p.abilityOffer[0]);
      p.abilityOffer = [];
    }
    record(true);
    log(state, "turn", `${p.name} 結束回合${p.ap > 0 ? `（剩餘 ${p.ap} AP）` : ""}`, pid);
    bump(p, "apWasted", p.ap);
    p.ap = 0;
    endTurn(content, state, now);
    touch(state);
    return { ok: true, messages: ["回合結束"] };
  }

  const plan = planAction(content, state, p, a);
  if ("error" in plan) return { ok: false, error: plan.error, messages: [] };
  if (plan.ap > p.ap) return { ok: false, error: `AP 不足（需要 ${plan.ap}）`, messages: [] };
  if (plan.cost && !canAfford(p, plan.cost)) return { ok: false, error: `資源不足（需要 ${fmtRes(plan.cost).replace(/\+/g, "")}）`, messages: [] };
  p.ap -= plan.ap;
  if (plan.cost) pay(p, plan.cost);
  const msg = plan.run();
  const dir = DIRECTION_OF[a.type];
  if (dir) p.directionActs[dir] = (p.directionActs[dir] ?? 0) + 1;
  record(true);
  if (!["CONTEST", "TRADE_OFFER", "TRADE_RESPOND", "POST_CONTRACT", "ACCEPT_CONTRACT", "RESPOND_CRISIS"].includes(a.type)) log(state, "action", `${p.name} ${msg}`, pid);
  touch(state);
  return { ok: true, messages: [msg] };
}

function setIdentity(content: Content, state: GameState, p: PlayerState, a: Extract<Action, { type: "SET_IDENTITY" }>): string | null {
  if (p.identityDone) return "你已經建立過身份";
  const dirs = [...new Set(a.directions)];
  if (dirs.length < 1 || dirs.length > 2) return "請選 1～2 個方向";
  if (!dirs.every((d) => content.identities.some((i) => i.id === d))) return "未知方向";
  if (!p.abilityOffer.includes(a.abilityId)) return "請從提供的能力中選擇";
  const objs = [...new Set(a.objectiveIds)];
  if (objs.length !== 2 || !objs.every((o) => p.objectiveOffer.includes(o))) return "請從三個秘密目標中保留兩個";
  const start = content.poiById[a.startPoi];
  if (!start?.tags.includes("hub")) return "起點必須是交通樞紐";

  p.directions = dirs;
  p.abilities = [a.abilityId];
  p.objectives = objs;
  p.abilityOffer = [];
  p.objectiveOffer = [];
  p.position = start.id;
  p.resources = { money: 0, influence: 0, info: 0, ...content.rules.startingResources } as PlayerState["resources"];
  const mult = dirs.length === 1 ? 1.5 : 1;
  for (const d of dirs) gain(p, content.identities.find((i) => i.id === d)!.start, mult);
  p.identityDone = true;
  const names = dirs.map((d) => content.identities.find((i) => i.id === d)!.name).join("＋");
  log(state, "system", `${p.name} 以「${names}」路線從 ${start.name} 出發`, p.id);
  return null;
}

// ============================================================
// Utilities for server / bots
// ============================================================

export function touch(state: GameState) {
  state.version += 1;
  state.updatedAt = Date.now();
}

/** Identity mix (%) derived from chosen directions, abilities, and what the player actually did. */
export function identityMix(content: Content, p: PlayerState): { id: string; pct: number }[] {
  const w: Record<string, number> = {};
  for (const d of p.directions) w[d] = (w[d] ?? 0) + 4;
  for (const a of p.abilities) {
    const d = content.abilityById[a]?.direction;
    if (d) w[d] = (w[d] ?? 0) + 2;
  }
  for (const [d, n] of Object.entries(p.directionActs)) w[d] = (w[d] ?? 0) + n * 0.4;
  const total = Object.values(w).reduce((s, v) => s + v, 0) || 1;
  return content.identities
    .map((i) => ({ id: i.id, pct: Math.round(((w[i.id] ?? 0) / total) * 100) }))
    .filter((x) => x.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

export { rand };
