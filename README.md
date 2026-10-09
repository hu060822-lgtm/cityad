# CITY 台中（暫名）

發生在真實台中市的多人回合制城市策略遊戲。2–6 人（可混 AI），6–15 回合，每回合 6 AP。
玩家自訂身份，在城市裡移動、探索、投資、交易、爭奪，並在終局一起面對城市危機。

> 設計文件：GDD《CITY／暫名》150 節（Luz）。本 repo 是依 GDD 實作的第一版。

## 快速開始（本機）

需要 Node 20 以上。

```bash
npm install
npm run dev          # 前端 http://localhost:5173 ，API 在 :3000（自動 proxy）
```

正式模式：

```bash
npm run build
npm start            # http://localhost:3000
```

沒有設定 `DATABASE_URL` 時使用記憶體存檔（重啟即清空），適合本機測試。

## 指令

| 指令 | 用途 |
|---|---|
| `npm run dev` | 開發模式（server + Vite 熱更新） |
| `npm run build` / `npm start` | 建置／啟動正式版 |
| `npm test` | 引擎測試（vitest） |
| `npm run typecheck` | TypeScript 型別檢查 |
| `npm run validate:data` | 檢查 `data/` 內容（重複 id、連線斷裂、座標範圍…） |
| `npm run verify:pois` | 用 OpenStreetMap 核實 POI 座標（需網路，見下方） |
| `npm run simulate -- --games 500 --rounds 8 --players 4` | AI 對打平衡模擬 |

## 部署到 Render（GitHub + Render）

1. 在 GitHub 建一個新的空 repo（不要勾 README）。
2. 在本資料夾：
   ```bash
   git remote add origin https://github.com/<你的帳號>/<repo>.git
   git push -u origin main
   ```
3. Render 後台 → **New → Blueprint** → 選這個 repo。Render 會讀 `render.yaml`，
   自動建立 Web Service `city-taichung` 和 PostgreSQL `city-db`，並把 `DATABASE_URL` 接好。
4. 部署完成後打開 `https://<服務名稱>.onrender.com/api/health`，看到 `"store":"postgres"` 就代表資料庫接上了。
5. 之後每次 `git push` 都會自動重新部署。

注意事項：

- 免費方案的 Web Service 閒置約 15 分鐘會休眠，第一次連線要等幾十秒喚醒。
- Render 免費 PostgreSQL 有使用期限（到期前會寄信通知），請到後台確認目前政策；到期可升級或重建資料庫。
- 若改用 Render 外部連線字串（External URL），需加環境變數 `PGSSL=true`。

### 環境變數

| 變數 | 說明 |
|---|---|
| `PORT` | Render 自動提供；伺服器監聽 `0.0.0.0:$PORT` |
| `DATABASE_URL` | 有設定就用 PostgreSQL，否則用記憶體 |
| `PGSSL` | `true` 時以 SSL 連線資料庫 |
| `ENABLE_DEBUG` | `true` 開啟遊戲內「開發」分頁（給錢、觸發事件、跳回合）。**正式環境請保持 false** |
| `ADMIN_KEY` | 管理統計 API 的金鑰；Blueprint 會自動產生。`GET /api/admin/summary`，header `x-admin-key` |

## POI 資料與核實（GDD §85–86）

所有地點資料在 `data/pois.json`。每筆都有：

- `source`：資料來源。`claude_recall` 代表由 AI 依記憶填寫、**尚未核實**；`osm:<type>/<id>` 代表已對到 OpenStreetMap。
- `verified` / `last_verified`：是否已核實、核實日期。

目前 74 筆全部是 `verified: false`，座標為估計值，請在自己電腦執行：

```bash
CONTACT_EMAIL=你的信箱 npm run verify:pois            # 產生報告 reports/poi-verify-日期.json
CONTACT_EMAIL=你的信箱 npm run verify:pois -- --write  # 把高信心結果寫回
npm run validate:data && npm test
```

- 只有「名稱相似、距離 3 km 內」的結果會寫回；其他（找不到、名稱不符、差太遠）留在報告給人工判斷。
- 查不到的地點可在該筆 POI 加 `"osmQuery": "更精確的查詢字串"` 後重跑。
- Nominatim 規範每秒最多一次請求，腳本已自動限速並快取在 `.cache/`。
- `npm run verify:pois -- --discover`：從 OSM 列出尚未收錄的台中景點候選（`reports/poi-candidates-日期.csv`）。
  這只是候選清單，加入遊戲時仍需手動填遊戲數值、地區、tags 與 `data/edges.json` 連線。

新增地點的方法見 [docs/DATA.md](docs/DATA.md)。

## 專案結構

```
data/            遊戲內容（全部 data-driven，程式裡不寫死 POI 名稱）
src/shared/      前後端共用型別
src/engine/      純遊戲邏輯：規則、事件、計分、AI、視圖投影（無 I/O，可重播）
src/server/      Express API、存檔（記憶體／PostgreSQL + 行動紀錄）
src/client/      React 前端（SVG 地圖，真實經緯度投影）
scripts/         模擬、資料檢查、POI 核實
tests/           引擎測試
docs/            平衡紀錄、資料說明
```

設計原則（對應 GDD）：伺服器是唯一真實來源、所有亂數只在伺服器（可序列化 RNG，同 seed 可重現）、
每個行動都寫入 `game_actions` 可重播、玩家只拿得到自己的視圖（他人秘密目標、未揭露事件都不會送到前端）、
超時玩家由 AI 代打、不淘汰玩家（破產進入「困境狀態」）。
