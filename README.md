# CF-RSS Worker

多來源 RSS 匯整與 Discord 推播的 Cloudflare Worker。程式會每小時抓取指定 RSS，依台灣時區 (UTC+8) 將當日所有文章寫入 KV，並分批最多五篇推送至對應的 Discord Webhook。

## 功能特色
- 每小時透過 Cron 觸發 `processRSS`，針對各來源抓取最新 RSS (`worker.js:72-148`)
- 解析文章後依「台北日期」建立每日 KV JSON，紀錄 `sent` 狀態與發送時間 (`worker.js:365-534`)
- 發送未推播的文章時維持發佈時間由舊到新的順序 (`worker.js:120-138`)
- 支援針對文章描述與縮圖的清理/擷取 (`worker.js:200-334`)
- 透過 `/trigger` 手動觸發測試，每個來源僅推送最新一篇 (`worker.js:60-74`)

## 部署前準備
1. **環境變數**：於 Cloudflare Dashboard > Worker > Settings 設定
   - `DISCORD_WEBHOOK_GNN`
   - `DISCORD_WEBHOOK_4GAMERS`
2. **KV Namespace**：綁定 `RSS_CACHE`，用於儲存每日文章 JSON (`worker.js:83-107`)
3. **Cron Trigger**：設定 `0 * * * *`，每小時自動執行 (`worker.js:72-75`)

## KV 資料結構
- **Key**：`daily:<來源識別>:<YYYY-MM-DD>`，日期以台灣時間換算 (`worker.js:384-386`)
- **Value**：JSON 物件，包括
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
- 每次發送成功後會將該筆 `sent` 標記為 `true`，並寫入 `sentAt` (`worker.js:120-133`)

## 執行流程
1. 每次排程觸發時讀取當日 KV 狀態；若無資料則建立空集合 (`worker.js:96-114`, `worker.js:389-449`)
2. 解析 RSS，僅保留當日 (台北時間) 文章並整合入 KV (`worker.js:166-233`, `worker.js:460-520`)
3. 遞增排序後擷取尚未發送的最多五篇文章並推送至 Discord (`worker.js:118-138`, `worker.js:540-579`)
4. 更新 KV，保留已發送/未發送的完整紀錄 (`worker.js:141-148`, `worker.js:452-458`)

## 測試方式
- 在瀏覽器或 API 工具呼叫 `GET https://<worker-url>/trigger`，可驗證單篇推播流程 (`worker.js:60-74`)

## 注意事項
- Cloudflare Worker 的 `fetch` 解析與 KV 操作皆為異步流程，必要時可透過 `console.log` 追蹤 (`worker.js:136-138`, `worker.js:144-148`)
- 若新增 RSS 來源，請同步補上 `webhookEnv` 與 `thumbnailStrategy` 等欄位 (`worker.js:20-38`)
