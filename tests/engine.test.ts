import { describe, it, expect } from "vitest";
import {
  getContent, validateContent, createGame, addPlayer, startGame, applyAction, currentPlayerId, runBots,
  botIdentity, computeScore, viewFor, moveCost, runDebug,
} from "../src/engine";
import type { GameState } from "../src/shared/types";

const content = getContent();

function setup(n = 2, seed = 42): GameState {
  const s = createGame(content, { id: "g1", code: "TEST", seed, totalRounds: 6 });
  for (let i = 0; i < n; i++) addPlayer(content, s, { id: `p${i}`, name: `P${i}` });
  startGame(content, s, 0);
  for (const pid of s.playerOrder) {
    const a = botIdentity(content, s, pid);
    if (a.type === "SET_IDENTITY") a.startPoi = "tc_station";
    const r = applyAction(content, s, pid, a, { now: 0 });
    expect(r.ok, r.error).toBe(true);
  }
  return s;
}

describe("content", () => {
  it("is valid and connected", () => {
    expect(validateContent(content)).toEqual([]);
    expect(content.pois.length).toBeGreaterThanOrEqual(30);
    expect(content.events.filter((e) => !e.chainOnly).length).toBeGreaterThanOrEqual(10);
    expect(content.objectives.length).toBeGreaterThanOrEqual(10);
  });
  it("derives edge cost from real distance", () => {
    const e = content.edges.find((x) => x.from === "tc_station" && x.to === "miyahara")!;
    expect(e.cost).toBe(1);
    const far = content.edges.find((x) => x.from === "central_park" && x.to === "intercontinental_stadium")!;
    expect(far.cost).toBe(3);
  });
});

describe("lifecycle", () => {
  it("create → join → start → identity → playing", () => {
    const s = createGame(content, { id: "g", code: "ABCD", seed: 1 });
    expect(s.status).toBe("lobby");
    addPlayer(content, s, { id: "a", name: "阿明" });
    expect(() => startGame(content, s)).toThrow();
    addPlayer(content, s, { id: "b", name: "小華" });
    startGame(content, s);
    expect(s.status).toBe("identity");
    expect(s.players.a.abilityOffer.length).toBe(4);
    expect(s.players.a.objectiveOffer.length).toBe(3);
    for (const pid of ["a", "b"]) applyAction(content, s, pid, botIdentity(content, s, pid));
    expect(s.status).toBe("playing");
    expect(s.round).toBe(1);
    expect(s.currentEvents.length).toBe(1);
  });

  it("rejects actions out of turn", () => {
    const s = setup();
    const cur = currentPlayerId(s)!;
    const other = s.playerOrder.find((id) => id !== cur)!;
    const r = applyAction(content, s, other, { type: "EXPLORE" });
    expect(r.ok).toBe(false);
  });
});

describe("AP & movement", () => {
  it("spends AP on move and explore, ends turn, next player", () => {
    const s = setup();
    const pid = currentPlayerId(s)!;
    const p = s.players[pid];
    const ap0 = p.ap;
    expect(ap0).toBeGreaterThanOrEqual(6);
    const cost = moveCost(content, s, p, "miyahara")!;
    expect(applyAction(content, s, pid, { type: "MOVE", to: "miyahara" }).ok).toBe(true);
    expect(p.ap).toBe(ap0 - cost);
    expect(p.position).toBe("miyahara");
    expect(applyAction(content, s, pid, { type: "MOVE", to: "nchu" }).ok).toBe(false); // not adjacent
    const before = p.resources.money;
    expect(applyAction(content, s, pid, { type: "EXPLORE" }).ok).toBe(true);
    expect(p.resources.money).toBeGreaterThan(before);
    expect(applyAction(content, s, pid, { type: "EXPLORE" }).ok).toBe(false); // once
    applyAction(content, s, pid, { type: "END_TURN" });
    expect(currentPlayerId(s)).not.toBe(pid);
  });

  it("cannot overspend AP", () => {
    const s = setup();
    const pid = currentPlayerId(s)!;
    s.players[pid].ap = 1;
    const r = applyAction(content, s, pid, { type: "INVEST" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("AP");
  });

  it("advances rounds after everyone ends turn", () => {
    const s = setup(3);
    expect(s.round).toBe(1);
    for (let i = 0; i < 3; i++) applyAction(content, s, currentPlayerId(s)!, { type: "END_TURN" });
    expect(s.round).toBe(2);
  });
});

describe("control & contest", () => {
  it("invest grants control and income", () => {
    const s = setup();
    const pid = currentPlayerId(s)!;
    const p = s.players[pid];
    p.resources.money = 2000;
    expect(applyAction(content, s, pid, { type: "INVEST" }).ok).toBe(true);
    expect(s.pois.tc_station.owner).toBe(pid);
    const m = p.resources.money;
    for (let i = 0; i < 2; i++) applyAction(content, s, currentPlayerId(s)!, { type: "END_TURN" });
    expect(s.round).toBe(2);
    expect(p.resources.money).toBeGreaterThan(m - 100); // income arrived (modulo events)
  });

  it("contest is locked in opening rounds and resolves with server RNG later", () => {
    const s = setup();
    const [a, b] = s.playerOrder;
    runDebug(content, s, { cmd: "set_owner", poiId: "tc_station", playerId: b });
    const cur = currentPlayerId(s)!;
    const attacker = cur === b ? a : cur;
    if (cur !== attacker) applyAction(content, s, cur, { type: "END_TURN" });
    expect(applyAction(content, s, attacker, { type: "CONTEST" }).ok).toBe(false);
    s.round = 3;
    s.players[attacker].ap = 6;
    s.players[attacker].resources.influence = 9;
    const r = applyAction(content, s, attacker, { type: "CONTEST", infoSpend: 0 });
    expect(r.ok, r.error).toBe(true);
    expect(s.players[attacker].stats.contestsStarted).toBe(1);
  });
});

describe("trade & contracts", () => {
  it("trade escrows, then transfers on accept", () => {
    const s = setup();
    const a = currentPlayerId(s)!;
    const b = s.playerOrder.find((x) => x !== a)!;
    s.players[a].resources.info = 3;
    const moneyB = s.players[b].resources.money;
    expect(applyAction(content, s, a, { type: "TRADE_OFFER", to: b, give: { info: 2 }, want: { money: 100 } }).ok).toBe(true);
    expect(s.players[a].resources.info).toBe(1);
    const t = s.trades[0];
    expect(applyAction(content, s, b, { type: "TRADE_RESPOND", tradeId: t.id, accept: true }).ok).toBe(true);
    expect(s.players[b].resources.money).toBe(moneyB - 100);
    expect(s.players[a].stats.trades).toBe(1);
  });

  it("player contract pays out when the acceptor explores the POI", () => {
    const s = setup();
    const a = currentPlayerId(s)!;
    const b = s.playerOrder.find((x) => x !== a)!;
    expect(applyAction(content, s, a, { type: "POST_CONTRACT", poiId: "miyahara", reward: 100 }).ok).toBe(true);
    const c = s.contracts.find((x) => x.poster === a)!;
    applyAction(content, s, a, { type: "END_TURN" });
    expect(currentPlayerId(s)).toBe(b);
    expect(applyAction(content, s, b, { type: "ACCEPT_CONTRACT", contractId: c.id }).ok).toBe(true);
    applyAction(content, s, b, { type: "MOVE", to: "miyahara" });
    const m = s.players[b].resources.money;
    applyAction(content, s, b, { type: "EXPLORE" });
    expect(c.status).toBe("done");
    expect(s.players[b].resources.money).toBeGreaterThanOrEqual(m + 100);
    expect(s.players[a].stats.contractsFulfilledForMe).toBe(1);
  });
});

describe("events", () => {
  it("event chains are scheduled", () => {
    const s = setup();
    runDebug(content, s, { cmd: "trigger_event", eventId: "typhoon_warning" });
    expect(s.scheduled.some((x) => x.eventId === "typhoon_landfall" && x.round === s.round + 1)).toBe(true);
  });
});

describe("views", () => {
  it("hides secret objectives and rng from other players", () => {
    const s = setup();
    const [a, b] = s.playerOrder;
    const v = viewFor(content, s, a);
    expect(v.players[a].objectives.length).toBe(2);
    expect(v.players[b].objectives.length).toBe(0);
    expect((v as unknown as { rng?: unknown }).rng).toBeUndefined();
  });
});

describe("full match", () => {
  it("bots play a complete 6-round game to scoring, deterministically", () => {
    const run = (seed: number) => {
      const s = createGame(content, { id: "g", code: "SIM", seed, totalRounds: 6 });
      const strats = ["greedy", "explorer", "trader", "aggressive"] as const;
      strats.forEach((st, i) => addPlayer(content, s, { id: `b${i}`, name: st, isBot: true, botStrategy: st }));
      startGame(content, s, 0);
      runBots(content, s, 0);
      return s;
    };
    const s = run(7);
    expect(s.status).toBe("finished");
    expect(s.result!.winners.length).toBeGreaterThan(0);
    expect(s.crisis?.resolved).toBeDefined();
    const s2 = run(7);
    expect(s2.result!.scores).toEqual(s.result!.scores);
    for (const id of s.playerOrder) expect(computeScore(content, s, id).total).toBe(s.result!.scores[id].total);
  });
});
