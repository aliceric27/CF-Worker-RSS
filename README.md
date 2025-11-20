# CF-RSS Worker

這個專案包含多個獨立的 Cloudflare Workers，用於抓取遊戲/生活資訊並推送到 Discord。所有 Worker 都共用同一個 KV Namespace：`RSS_CACHE`。

目前包含的 Worker：
- `news-rss.js` – 多來源遊戲新聞 RSS → Discord
- `bahamut-forum.js` – 巴哈姆特 FFXIV 論壇人氣文章推送
- `ffxiv-fb.js` – FFXIV Facebook 粉絲團 RSS → Discord (可選 AI 優化)
- `ptt-lifeismoney.js` – PTT Lifeismoney 省錢板推文監控 → Discord

---

## 共用設定

### KV Namespace
- Cloudflare Dashboard 綁定：
  - **Variable name**：`RSS_CACHE`
  - 用於儲存每日文章 JSON 或 sent map，避免重複推播。

### 一般 KV key 規則
- 每日狀態：`daily:<sourceId>:<YYYY-MM-DD>` (台北時間)
- 去重映射：`sent:<sourceId>` (部分 Worker 使用)

---

## news-rss.js (多來源遊戲 RSS)

- 多來源 RSS 匯整與 Discord 推播的 Cloudflare Worker。程式會每小時抓取指定 RSS，依台灣時區 (UTC+8) 將當日所有文章寫入 KV，並分批最多五篇推送至對應的 Discord Webhook。

### 部署前準備
1. **環境變數**：於 Cloudflare Dashboard > Worker > Settings 設定
   - `DISCORD_WEBHOOK_GNN`
   - `DISCORD_WEBHOOK_4GAMERS`
   - `DISCORD_WEBHOOK_PTT_STEAM`
2. **KV Namespace**：綁定 `RSS_CACHE`
3. **Cron Trigger**：設定 `0 * * * *` (每小時)

### 主要 KV 結構 (news-rss.js)
- **Key**：`daily:<來源識別>:<YYYY-MM-DD>` (台北時間)
- **Value** 範例：
  ```jsonc
  {
    "sourceName": "巴哈姆特 GNN 新聞網",
    "sourceUrl": "https://gnn.gamer.com.tw/rss.xml",
    "sourceId": "DISCORD_WEBHOOK_GNN",
    "dateKey": "2024-05-10",
    "timezone": "Asia/Taipei",
    "articles": [
      {
        "link": "https://example.com/article",
        "title": "文章標題",
        "description": "純文字描述",
        "thumbnail": "https://example.com/image.jpg",
        "publishedAt": "2024-05-10T02:30:00.000Z",
        "publishedAtMs": 1715317800000,
        "sent": false,
        "sentAt": null
      }
    ],
    "updatedAt": "2024-05-10T03:00:00.000Z"
  }
  ```

---

## ptt-lifeismoney.js (PTT 省錢板)

定期抓取 PTT Lifeismoney 看板首頁 (`https://www.ptt.cc/bbs/Lifeismoney/index.html`)，只保留「當日」文章，並依推文數決定是否推送到 Discord。

### 行為摘要
- 每次執行：
  - 使用 `GET` 抓取 Lifeismoney index 頁面 HTML
  - 解析每個 `<div class="r-ent">` 區塊：
    - 推文數：`<div class="nrec"><span class="hl f3">61</span></div>`
    - 標題與連結：`<div class="title"><a href="/bbs/Lifeismoney/M.1763461499.A.7E1.html">...</a></div>`
    - 作者：`<div class="author">作者名稱</div>`
    - 日期：`<div class="date">MM/DD</div>`
  - 僅保留日期等於「今日台北時間」的文章
  - 以當天日期 `YYYY-MM-DD` 建立每日 KV 狀態，TTL = 2 天
  - 每次呼叫會更新該日所有文章的最新推文數
  - 若推文數 `>= 30` 且尚未發送過，則推送到 Discord
  - 避免重複發送：每日 JSON 內對每篇文章記錄 `sent`/`sentAt`

### 環境變數
- 在 Cloudflare Dashboard 為 `ptt-lifeismoney.js` Worker 設定：
  - `DISCORD_WEBHOOK_LIFEISMONEY`：Discord Webhook URL

### Cron Trigger 建議
- 每 30 分鐘執行一次，例如：
  - `*/30 * * * *`

### KV 資料結構 (ptt-lifeismoney.js)
- **Key**：`daily:ptt-lifeismoney:<YYYY-MM-DD>` (台北時間)
- **Value**：JSON 物件，使用文章 ID (`M.1763461499.A.7E1`) 作為 key：
  ```jsonc
  {
    "sourceName": "PTT Lifeismoney 省錢板",
    "sourceId": "ptt-lifeismoney",
    "board": "Lifeismoney",
    "dateKey": "2025-11-19",
    "timezone": "Asia/Taipei",
    "items": {
      "M.1763461499.A.7E1": {
        "id": "M.1763461499.A.7E1",
        "url": "https://www.ptt.cc/bbs/Lifeismoney/M.1763461499.A.7E1.html",
        "title": "[情報] 肯德基6雞6塔333元",
        "author": "lioucat",
        "push": 61,
        "sent": true,
        "sentAt": "2025-11-19T03:10:00.000Z"
      }
    },
    "updatedAt": "2025-11-19T03:10:00.000Z"
  }
  ```

### 測試方式
- 手動觸發單次執行：
  - `GET https://<ptt-lifeismoney-worker>/trigger`

---

## 其他 Workers

更詳細的資料流、去重策略與各 Worker 的行為，可參考 `CLAUDE.md`。*** End Patch``` ***!
