import type { Content, GameState, CityReport } from "../shared/types";
import { identityMix } from "./game";
import { controlledPois, districtDominance, playerSynergies } from "./scoring";

const TITLES: Record<string, string> = {
  commerce: "商業核心",
  explore: "城市漫遊者",
  intel: "情報掮客",
  control: "地方勢力",
  social: "城市交際家",
};

const STAT_LABEL: Record<string, string> = {
  commerce: "商業繁榮", culture: "文化復興", mobility: "交通活絡", nature: "綠地熱門",
  tourism: "觀光湧入", knowledge: "學術興盛", order: "市民團結",
};

/** Generates the shareable "本局城市紀錄". */
export function buildReport(content: Content, state: GameState): CityReport {
  const res = state.result!;
  const players = state.playerOrder.map((id) => state.players[id]);
  const s = (id: string, k: string) => state.players[id].stats[k] ?? 0;

  const playerLines = players.map((p) => {
    const mix = identityMix(content, p);
    const top = mix[0]?.id ?? "explore";
    const owned = controlledPois(state, p.id).length;
    const parts = [`探索 ${p.visited.length} 個地點`];
    if (owned) parts.push(`控制 ${owned} 處`);
    if (s(p.id, "trades")) parts.push(`完成 ${s(p.id, "trades")} 次交易`);
    if (s(p.id, "contestsWon")) parts.push(`爭奪成功 ${s(p.id, "contestsWon")} 次`);
    if (s(p.id, "contractsCompleted")) parts.push(`完成 ${s(p.id, "contractsCompleted")} 個委託`);
    const syn = playerSynergies(content, state, p.id).map((x) => x.def.name);
    if (syn.length) parts.push(`打造了${syn.join("、")}`);
    let title = TITLES[top];
    if (p.flags.recovered) title = "逆境翻身者";
    return { playerId: p.id, title, line: `${p.name} 成為${title}：${parts.join("，")}。` };
  });

  const dom = districtDominance(content, state);
  const districtLines = content.districts.map((d) => {
    const pois = content.pois.filter((p) => p.district === d.id);
    const activity = pois.reduce((sum, p) => sum + state.pois[p.id].activity, 0);
    const invested = pois.filter((p) => state.pois[p.id].owner).length;
    const owner = dom[d.id];
    const mood = activity >= pois.length * 2 ? "人聲鼎沸" : activity >= pois.length ? "穩定發展" : "安靜沉睡";
    const who = owner ? `由 ${state.players[owner].name} 主導` : invested ? "群雄割據" : "無人經營";
    return { districtId: d.id, line: `${d.name}：${mood}，${who}（${invested}/${pois.length} 處有人經營）。` };
  });

  const highlights: CityReport["highlights"] = [];
  const maxBy = (k: string) => {
    let best: string | null = null;
    let v = 0;
    for (const p of players) if ((p.stats[k] ?? 0) > v) (v = p.stats[k] ?? 0, (best = p.id));
    return best ? { id: best, v } : null;
  };
  const exp = maxBy("explored");
  if (exp) highlights.push({ label: "最會跑", text: `${state.players[exp.id].name} 探索了 ${exp.v} 個地點` });
  const tr = maxBy("trades");
  if (tr) highlights.push({ label: "最會談", text: `${state.players[tr.id].name} 完成 ${tr.v} 次交易` });
  const ct = maxBy("contestsWon");
  if (ct) highlights.push({ label: "最敢搶", text: `${state.players[ct.id].name} 爭奪成功 ${ct.v} 次` });
  if (state.crisis) {
    const def = content.crises.find((c) => c.id === state.crisis!.crisisId)!;
    const total = Object.values(state.crisis.contributions).reduce((a, b) => a + b, 0);
    highlights.push({ label: "城市危機", text: `${def.name}：${state.crisis.resolved === "success" ? "成功化解" : "沒能撐住"}（${total}/${state.crisis.target}）` });
  }
  const topStat = Object.entries(state.city).sort((a, b) => b[1] - a[1])[0];
  if (topStat && topStat[1] > 0) highlights.push({ label: "城市氣氛", text: `這一局的台中以「${STAT_LABEL[topStat[0]]}」為主調` });
  for (const p of players) if (p.flags.recovered) highlights.push({ label: "逆轉", text: `${p.name} 從困境中翻身` });

  const achievements: CityReport["achievements"] = [];
  for (const p of players) {
    const add = (id: string, name: string) => achievements.push({ playerId: p.id, id, name });
    if (p.visited.length >= 12) add("wanderer", "都市漫遊者");
    if (p.flags.recovered) add("self_made", "空手起家");
    if (p.resources.info >= 10) add("intel_web", "情報網");
    if (playerSynergies(content, state, p.id).length >= 2) add("architect", "城市建築師");
    if (!s(p.id, "contestsStarted") && res.winners.includes(p.id)) add("peaceful_merchant", "和平商人");
    if (state.crisis?.resolved === "success") {
      const max = Math.max(...Object.values(state.crisis.contributions));
      if ((state.crisis.contributions[p.id] ?? 0) === max && max > 0) add("city_hero", "城市英雄");
    }
  }

  const w = res.winners.map((id) => state.players[id].name).join("、");
  const wl = playerLines.find((l) => l.playerId === res.winners[0]);
  return {
    headline: `這一局的台中，${w} 以${wl?.title ?? "自己的方式"}勝出。`,
    playerLines,
    districtLines,
    highlights,
    achievements,
  };
}
