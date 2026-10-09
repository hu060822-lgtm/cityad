/**
 * Balance simulation: bots play N games and report metrics from doc §82 / §105.
 * Usage: npm run simulate -- --games 1000 --rounds 8 --players 4
 */
import { getContent, createGame, addPlayer, startGame, runBots, BOT_STRATEGIES, identityMix } from "../src/engine";
import type { BotStrategy } from "../src/shared/types";

const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map((s) => s.trim().split(/\s+/)));
const GAMES = Number(args.games ?? 500);
const ROUNDS = Number(args.rounds ?? 8);
const PLAYERS = Number(args.players ?? 4);
const content = getContent();

const wins: Record<string, number> = {};
const plays: Record<string, number> = {};
// fair share: random bots almost never win, so each game's win is split among the non-random bots
const fair: Record<string, number> = {};
const winDir: Record<string, number> = {};
const scoreParts: Record<string, number> = {};
let apLeft = 0, turns = 0, actions = 0, trades = 0, contests = 0, crisisOk = 0, struggle = 0, comeback = 0, objDone = 0, objTotal = 0;
const poiVisits: Record<string, number> = {};
const poiControl: Record<string, number> = {};
let margin = 0;

for (let g = 0; g < GAMES; g++) {
  const s = createGame(content, { id: `sim${g}`, code: "SIM", seed: 1000 + g, totalRounds: ROUNDS });
  const strats: BotStrategy[] = [];
  for (let i = 0; i < PLAYERS; i++) {
    const st = BOT_STRATEGIES[(g + i) % BOT_STRATEGIES.length];
    strats.push(st);
    addPlayer(content, s, { id: `b${i}`, name: st, isBot: true, botStrategy: st });
    plays[st] = (plays[st] ?? 0) + 1;
  }
  const competent = strats.filter((x) => x !== "random").length;
  for (const st of strats) fair[st] = (fair[st] ?? 0) + (st === "random" ? 0 : 1 / competent);
  startGame(content, s, 0);
  runBots(content, s, 0);
  if (s.status !== "finished") throw new Error(`game ${g} did not finish`);
  const r = s.result!;
  const w = r.ranking[0];
  const ws = s.players[w].botStrategy!;
  wins[ws] = (wins[ws] ?? 0) + 1;
  const dir = identityMix(content, s.players[w])[0]?.id ?? "?";
  winDir[dir] = (winDir[dir] ?? 0) + 1;
  margin += r.scores[r.ranking[0]].total - r.scores[r.ranking[1]].total;
  for (const [k, v] of Object.entries(r.scores[w])) if (typeof v === "number" && k !== "total") scoreParts[k] = (scoreParts[k] ?? 0) + v;
  for (const id of s.playerOrder) {
    const p = s.players[id];
    apLeft += p.stats.apWasted ?? 0;
    trades += p.stats.trades ?? 0;
    contests += p.stats.contestsStarted ?? 0;
    if (p.flags.everStruggled) struggle++;
    if (p.flags.recovered) comeback++;
    objTotal += p.objectives.length;
    objDone += r.scores[id].completedObjectives.length;
    for (const v of p.visited) poiVisits[v] = (poiVisits[v] ?? 0) + 1;
  }
  for (const [pid, st] of Object.entries(s.pois)) if (st.owner) poiControl[pid] = (poiControl[pid] ?? 0) + 1;
  turns += ROUNDS * PLAYERS;
  actions += s.actions.length;
  if (s.crisis?.resolved === "success") crisisOk++;
}

const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
console.log(`\n=== ${GAMES} games · ${PLAYERS} bots · ${ROUNDS} rounds ===\n`);
console.log("Win rate by bot strategy (fair = expected share if all non-random bots were equal)");
for (const st of BOT_STRATEGIES) console.log(`  ${st.padEnd(11)} ${pct(wins[st] ?? 0, plays[st] ?? 1).padStart(6)}   fair ${pct(fair[st] ?? 0, plays[st] ?? 1)}`);
console.log("\nWinner's dominant identity direction");
for (const [d, n] of Object.entries(winDir).sort((a, b) => b[1] - a[1])) console.log(`  ${d.padEnd(11)} ${pct(n, GAMES)}`);
console.log("\nAverage winner score breakdown");
for (const [k, v] of Object.entries(scoreParts)) console.log(`  ${k.padEnd(12)} ${(v / GAMES).toFixed(1)}`);
console.log(`\navg winning margin     ${(margin / GAMES).toFixed(1)}`);
console.log(`actions per turn       ${(actions / turns).toFixed(2)}`);
console.log(`avg AP left per turn   ${(apLeft / turns).toFixed(2)}`);
console.log(`trades per game        ${(trades / 2 / GAMES).toFixed(2)}`);
console.log(`contests per game      ${(contests / GAMES).toFixed(2)}`);
console.log(`crisis success rate    ${pct(crisisOk, GAMES)}`);
console.log(`struggling rate        ${pct(struggle, GAMES * PLAYERS)}`);
console.log(`comeback rate          ${pct(comeback, Math.max(1, struggle))} of struggling players`);
console.log(`objective completion   ${pct(objDone, objTotal)}`);
const visits = content.pois.map((p) => [p.name, poiVisits[p.id] ?? 0] as const).sort((a, b) => a[1] - b[1]);
console.log(`\nLeast explored POIs: ${visits.slice(0, 5).map(([n, v]) => `${n}(${(v / GAMES).toFixed(2)})`).join(", ")}`);
const ctrl = content.pois.map((p) => [p.name, poiControl[p.id] ?? 0] as const).sort((a, b) => b[1] - a[1]);
console.log(`Most controlled POIs: ${ctrl.slice(0, 5).map(([n, v]) => `${n}(${pct(v, GAMES)})`).join(", ")}\n`);
