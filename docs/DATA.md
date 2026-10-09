# 資料檔說明

所有內容都在 `data/`，改完執行 `npm run validate:data && npm test`。

| 檔案 | 內容 |
|---|---|
| `pois.json` | 地點（74） |
| `edges.json` | 移動連線（108）。`walk` / `road` 依真實距離換算 AP（≤0.9 km＝1、≤2.2 km＝2、其餘 3）；`rail` 固定 2 AP |
| `districts.json` | 遊戲地區（8），主導獎勵 |
| `rules.json` | 規則數值（AP、起始資源、換分比例…） |
| `identities.json` / `abilities.json` / `objectives.json` | 身份方向、能力、秘密目標 |
| `city_goals.json` / `synergies.json` | 公開城市目標、地點組合 |
| `events.json` / `crises.json` | 城市事件（含事件鏈）、終局危機 |

## 新增一個地點

1. 在 `pois.json` 加一筆，**不可虛構**：必須是真實存在的地點，`source` 寫明來源。
   ```json
   {
     "id": "唯一英文 id", "name": "正式名稱", "category": "food",
     "tier": 2, "lat": 24.1, "lng": 120.6, "region": "行政區", "district": "遊戲地區 id",
     "tags": ["food", "market"], "investCost": 220,
     "income": {"money": 40}, "explore": {"money": 30}, "workPay": 70, "defense": 1,
     "blurb": "一句話介紹",
     "source": "osm:node/123456", "verified": true, "last_verified": "2026-09-22"
   }
   ```
2. 在 `edges.json` 至少接一條連線到附近地點（`validate:data` 會擋孤立節點與不連通的圖）。
3. 平衡參考（目前數值慣例）：
   - tier 1：投資 280–340、防禦 2–3；tier 2：200–260、防禦 1–2；tier 3：150–170、防禦 1。
   - 非 tier 1 地點的影響力收益最多 1。探索獎勵不給影響力（避免探索路線過強）。
   - `tags` 決定組合、事件、危機回應，請盡量沿用既有標籤。
4. 跑 `npm run simulate` 看有沒有地點被過度控制或完全沒人去。
