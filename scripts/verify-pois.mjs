#!/usr/bin/env node
/**
 * POI 座標核實與候選地點探勘（OpenStreetMap）
 * ------------------------------------------------------------
 * 需要網路，請在自己電腦上執行（Node 20+，不需額外套件）。
 *
 *   npm run verify:pois                     # 核實所有 verified:false 的地點，只產生報告
 *   npm run verify:pois -- --all            # 連已核實的也重查
 *   npm run verify:pois -- --only gaomei,lihpao
 *   npm run verify:pois -- --write          # 把「高信心」結果寫回 data/pois.json
 *   npm run verify:pois -- --discover       # 從 OSM 列出尚未收錄的台中候選地點（CSV）
 *
 * 規則（對應 GDD §85–86「禁止虛構 POI」）：
 *   - 只有「名稱相似度 ≥ 0.6 且 與原座標距離 ≤ 3 km」的結果會被 --write 寫回，
 *     並記錄 source=osm:<type>/<id>、verified=true、last_verified=今天。
 *   - 其他情況（找不到、名稱不像、距離太遠）一律不動，列在報告裡給人工判斷。
 *   - --discover 只產生候選清單，不會自動加入遊戲。加入時仍須人工填寫遊戲數值與連線。
 *
 * 使用規範：Nominatim 限制每秒最多 1 次請求、必須帶可識別的 User-Agent。
 * 請設定環境變數 CONTACT_EMAIL（寫在 User-Agent 裡），結果會快取在 .cache/，重跑不會重複查詢。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POIS = path.join(ROOT, "data/pois.json");
const CACHE_DIR = path.join(ROOT, ".cache");
const CACHE = path.join(CACHE_DIR, "nominatim.json");
const REPORT_DIR = path.join(ROOT, "reports");

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const CONTACT = process.env.CONTACT_EMAIL || "";
const UA = `city-game-taichung/0.2 (${CONTACT || "no-contact-set"})`;
const NOMINATIM = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const OVERPASS = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
// 台中市大致範圍（west, north, east, south）
const VIEWBOX = "120.45,24.45,121.05,23.95";
const OK_M = 150, WRITE_MAX_M = 3000, MIN_SIM = 0.6;

const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers
function haversineM(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const norm = (s) => String(s || "")
  .replace(/臺/g, "台").replace(/[\s()（）・·．.,，\-－_「」『』]/g, "")
  .replace(/^(國立|市立|台中市立|台中市)/, "").toLowerCase();
/** Character-bigram Dice similarity — works well enough for Chinese names. */
function similarity(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y || x.includes(y) || y.includes(x)) return 1;
  const grams = (s) => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
  const gx = grams(x), gy = grams(y);
  let inter = 0; for (const [k, v] of gx) inter += Math.min(v, gy.get(k) || 0);
  const total = Math.max(1, x.length - 1) + Math.max(1, y.length - 1);
  return (2 * inter) / total;
}
function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; } }
function saveCache(c) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c, null, 1)); }

let lastCall = 0;
async function nominatim(q, cache) {
  if (cache[q]) return cache[q];
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = `${NOMINATIM}/search?${new URLSearchParams({ q, format: "jsonv2", limit: "8", countrycodes: "tw", "accept-language": "zh-TW", viewbox: VIEWBOX, bounded: "1", namedetails: "1" })}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 429) { console.warn("  ⚠ 被限流，等 30 秒再試"); await sleep(30000); return nominatim(q, cache); }
  if (!res.ok) throw new Error(`Nominatim ${res.status} for "${q}"`);
  const data = await res.json();
  cache[q] = data;
  saveCache(cache);
  return data;
}

function queriesFor(p) {
  const qs = [];
  if (p.osmQuery) qs.push(p.osmQuery); // optional manual override in pois.json
  qs.push(p.name, `${p.name} ${p.region}`);
  const alt = p.name.replace(/臺/g, "台");
  if (alt !== p.name) qs.push(alt);
  return [...new Set(qs)];
}

function best(p, results) {
  let top = null;
  for (const r of results) {
    const names = [r.name, r.display_name?.split(",")[0], ...Object.values(r.namedetails || {})].filter(Boolean);
    const sim = Math.max(...names.map((n) => similarity(p.name, n)));
    const pt = { lat: Number(r.lat), lng: Number(r.lon) };
    const dist = haversineM(p, pt);
    // prefer name match, then proximity to our current (approximate) coordinates
    const score = sim * 10 - Math.min(dist, 20000) / 2000;
    if (!top || score > top.score) top = { r, sim, dist, pt, score, osm: `${r.osm_type}/${r.osm_id}`, label: names[0] };
  }
  return top;
}

// ---------------------------------------------------------------- verify
async function verify() {
  if (!CONTACT) console.warn("⚠ 建議設定 CONTACT_EMAIL（Nominatim 使用規範要求可識別的 User-Agent）\n");
  const pois = JSON.parse(fs.readFileSync(POIS, "utf8"));
  const only = opt("--only")?.split(",");
  const targets = pois.filter((p) => (only ? only.includes(p.id) : flag("--all") || !p.verified));
  const cache = loadCache();
  const rows = [];
  console.log(`核實 ${targets.length} 個地點…\n`);
  for (const p of targets) {
    let top = null;
    for (const q of queriesFor(p)) {
      const res = await nominatim(q, cache);
      const b = res.length ? best(p, res) : null;
      if (b && (!top || b.score > top.score)) top = b;
      if (top && top.sim >= 0.9 && top.dist < OK_M) break;
    }
    let status;
    if (!top) status = "NOT_FOUND";
    else if (top.sim < MIN_SIM) status = "NAME_MISMATCH";
    else if (top.dist <= OK_M) status = "OK";
    else if (top.dist <= WRITE_MAX_M) status = "SHIFT";
    else status = "FAR";
    const row = {
      id: p.id, name: p.name, status,
      matched: top?.label ?? "", similarity: top ? Number(top.sim.toFixed(2)) : 0,
      distance_m: top ? Math.round(top.dist) : null,
      old: { lat: p.lat, lng: p.lng }, osm: top ? { lat: +top.pt.lat.toFixed(5), lng: +top.pt.lng.toFixed(5), ref: top.osm, display: top.r.display_name } : null,
    };
    rows.push(row);
    const icon = { OK: "✓", SHIFT: "↔", FAR: "✗", NAME_MISMATCH: "?", NOT_FOUND: "∅" }[status];
    console.log(`${icon} ${p.name.padEnd(12, "　")} ${status.padEnd(13)} ${row.distance_m ?? "-"}m  ${row.matched}`);
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `poi-verify-${today}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(rows, null, 1));
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\nOK ${count("OK")}・位移 ${count("SHIFT")}・過遠 ${count("FAR")}・名稱不符 ${count("NAME_MISMATCH")}・找不到 ${count("NOT_FOUND")}`);
  console.log(`報告：${path.relative(ROOT, reportPath)}`);

  if (flag("--write")) {
    let n = 0;
    for (const row of rows) {
      if (!(row.status === "OK" || row.status === "SHIFT")) continue;
      const p = pois.find((x) => x.id === row.id);
      p.lat = row.osm.lat; p.lng = row.osm.lng;
      p.source = `osm:${row.osm.ref}`; p.verified = true; p.last_verified = today;
      n++;
    }
    fs.writeFileSync(POIS, JSON.stringify(pois, null, 1) + "\n");
    console.log(`\n已寫回 ${n} 筆到 data/pois.json。其餘請看報告人工處理（可在該 POI 加上 "osmQuery" 欄位指定查詢字串後重跑）。`);
    console.log("接著執行：npm run validate:data && npm test（移動成本會依新座標自動重算）");
  } else {
    console.log("\n（未寫入。確認報告後加上 --write 才會更新 data/pois.json）");
  }
}

// ---------------------------------------------------------------- discover
const CATEGORY_GUESS = [
  [/museum|gallery|arts_centre|theatre/, "culture"], [/place_of_worship|temple|shrine/, "religion"],
  [/marketplace|market/, "food"], [/park|garden|nature_reserve|viewpoint|wetland|beach/, "nature"],
  [/university|college|library/, "education"], [/mall|department_store/, "shopping"],
  [/station|bus_station|aerodrome/, "transport"], [/theme_park|stadium|zoo/, "entertainment"],
  [/historic|monument|memorial|castle|ruins/, "culture"], [/attraction/, "tourism"],
];
async function discover() {
  const pois = JSON.parse(fs.readFileSync(POIS, "utf8"));
  const [w, n, e, s] = VIEWBOX.split(",").map(Number);
  const bbox = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:120];
(
  nwr["tourism"~"attraction|museum|gallery|viewpoint|theme_park|zoo"]["name"](${bbox});
  nwr["historic"]["name"]["wikidata"](${bbox});
  nwr["amenity"~"marketplace|place_of_worship|university|library|arts_centre|theatre"]["name"]["wikidata"](${bbox});
  nwr["leisure"~"park|nature_reserve|stadium"]["name"]["wikidata"](${bbox});
  nwr["shop"~"mall|department_store"]["name"](${bbox});
);
out center tags;`;
  console.log("查詢 Overpass（可能要 30–90 秒）…");
  const res = await fetch(OVERPASS, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: q }) });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const data = await res.json();
  const seen = new Set();
  const out = [];
  for (const el of data.elements) {
    const t = el.tags || {};
    const name = t["name:zh-Hant"] || t["name:zh"] || t.name;
    if (!name || !/[\u4e00-\u9fff]/.test(name)) continue;
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    // skip anything already in the game (by name or within 120 m with similar name)
    if (pois.some((p) => similarity(p.name, name) >= 0.8 || (haversineM(p, { lat, lng }) < 120 && similarity(p.name, name) >= 0.4))) continue;
    const kind = [t.tourism, t.historic && "historic", t.amenity, t.leisure, t.shop, t.railway, t.aeroway].filter(Boolean).join("|");
    const category = CATEGORY_GUESS.find(([re]) => re.test(kind))?.[1] ?? "tourism";
    // crude "notability" signal so the CSV sorts useful places first
    const notability = (t.wikidata ? 3 : 0) + (t.wikipedia ? 2 : 0) + (t.website ? 1 : 0) + (t["name:en"] ? 1 : 0);
    out.push({ name, category, kind, lat: +lat.toFixed(5), lng: +lng.toFixed(5), notability, osm: `${el.type}/${el.id}`, wikidata: t.wikidata || "" });
  }
  out.sort((a, b) => b.notability - a.notability);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const csvPath = path.join(REPORT_DIR, `poi-candidates-${today}.csv`);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  fs.writeFileSync(csvPath, "\uFEFF" + ["name,category_guess,osm_kind,lat,lng,notability,osm,wikidata", ...out.map((r) => [r.name, r.category, r.kind, r.lat, r.lng, r.notability, r.osm, r.wikidata].map(esc).join(","))].join("\n"));
  console.log(`找到 ${out.length} 個尚未收錄的候選地點 → ${path.relative(ROOT, csvPath)}`);
  console.log("這只是候選清單：挑選後請手動加入 data/pois.json（遊戲數值、district、tags）與 data/edges.json。source 填 osm:<type>/<id>。");
}

// ---------------------------------------------------------------- main
if (flag("--help") || flag("-h")) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
} else {
  (flag("--discover") ? discover() : verify()).catch((e) => { console.error("✗", e.message); process.exit(1); });
}

export { similarity, haversineM, norm };
