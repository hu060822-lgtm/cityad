// Client-side access to the same data + pure engine helpers the server uses.
// The client only uses these for *previews* (button states, AP costs, paths);
// every action is still validated by the server, which is the single source of truth.
import { buildContent } from "../engine/content";
import { checkAction, identityMix } from "../engine/game";
import { objectiveProgress, playerSynergies, districtDominance, controlledPois } from "../engine/scoring";
import { shortestPath, fmtRes, hasTag, isClosed, currentPlayerId, phaseName } from "../engine/helpers";
import type { Action, GameState, GameView } from "../shared/types";

export const content = buildContent();
export const poiName = (id: string) => content.poiById[id]?.name ?? id;
export const asState = (v: GameView) => v as unknown as GameState;
export const check = (v: GameView, a: Action) => (v.me ? checkAction(content, asState(v), v.me, a) : { ok: false, error: "觀戰中" });

export const CATEGORY_GLYPH: Record<string, string> = {
  transport: "站", food: "食", culture: "文", nature: "綠", religion: "廟", shopping: "商",
  education: "學", entertainment: "娛", government: "府", tourism: "觀", health: "醫",
};
export const CATEGORY_NAME: Record<string, string> = {
  transport: "交通", food: "餐飲", culture: "文化", nature: "自然", religion: "宗教", shopping: "購物",
  education: "教育", entertainment: "娛樂", government: "政府", tourism: "觀光", health: "醫療",
};
export const TIER_NAME: Record<number, string> = { 1: "主要地標", 2: "次要地點", 3: "探索地點" };
export const IDENTITY_COLOR: Record<string, string> = {
  commerce: "#E8A33D", explore: "#3C9D5D", intel: "#2E86AB", control: "#D1495B", social: "#8E5CC4",
};

export { identityMix, objectiveProgress, playerSynergies, districtDominance, controlledPois, shortestPath, fmtRes, hasTag, isClosed, currentPlayerId, phaseName };
