/**
 * 資料檢查：npm run validate:data
 * 結構錯誤（重複 id、連線斷裂、未知地區…）→ 失敗；未核實的 POI → 只提醒。
 */
import { buildContent, validateContent } from "../src/engine/content";

const c = buildContent();
const problems = validateContent(c);
const unverified = c.pois.filter((p) => !p.verified);
const byDistrict = c.districts.map((d) => `${d.name} ${c.pois.filter((p) => p.district === d.id).length}`).join("・");

console.log(`POI ${c.pois.length}・連線 ${c.edges.length}・事件 ${c.events.length}・能力 ${c.abilities.length}・秘密目標 ${c.objectives.length}`);
console.log(`各地區：${byDistrict}`);
const longest = [...c.edges].sort((a, b) => (b.distanceKm ?? 0) - (a.distanceKm ?? 0)).slice(0, 3);
console.log(`最長連線：${longest.map((e) => `${c.poiById[e.from].name}—${c.poiById[e.to].name} ${e.distanceKm}km/${e.cost}AP`).join("、")}`);
if (unverified.length) console.log(`\n⚠ ${unverified.length} 個 POI 尚未核實座標（npm run verify:pois）：${unverified.slice(0, 8).map((p) => p.name).join("、")}${unverified.length > 8 ? "…" : ""}`);
if (problems.length) {
  console.error(`\n✗ ${problems.length} 個資料問題：`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("\n✓ 資料結構檢查通過");
