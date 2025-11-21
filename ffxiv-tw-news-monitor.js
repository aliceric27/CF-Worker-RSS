/**
 * FFXIV 台灣官網新聞監控 Worker
 *
 * 功能：
 * 1. 從 KV 讀取 FFXIV 台灣官網新聞資料
 * 2. 使用 KV 儲存去重機制，避免重複發送
 * 3. 首次執行僅記錄現有文章，不發送通知
 * 4. 後續執行僅發送新增的文章到 Discord
 *
 * 環境變數需求：
 * - DISCORD_WEBHOOK_FFXIV_TW_NEWS: Discord Webhook URL
 *
 * KV Binding 需求：
 * - ffxivnews: 讀取新聞資料 (key: ffxiv_news_v3)
 * - RSS_CACHE: 儲存 sent map
 */

// ==================== 常數定義 ====================

const NEWS_KV_KEY = 'ffxiv_news_v3';
const KV_SNAPSHOT_KEY = 'snapshot:ffxiv-tw-news';
const SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天
const KV_SENT_MAP_KEY = 'sent:ffxiv-tw-news';
const SENT_MAP_TTL_SECONDS = 365 * 24 * 60 * 60; // 365 天
const MAX_SENT_MAP_SIZE = 500; // 最大保存 500 筆記錄

// 分類圖示映射
const CATEGORY_ICONS = {
  '活動': 'https://cdn.discordapp.com/emojis/1441345802365833227.png',
  '維修': 'https://cdn.discordapp.com/emojis/1441333060619468800.png',
  '維護': 'https://cdn.discordapp.com/emojis/1441333060619468800.png', // 同義詞
  '公告': 'https://cdn.discordapp.com/emojis/1441333039941812224.png',
  '更新': 'https://cdn.discordapp.com/emojis/1441333039941812224.png',
  '其他': 'https://cdn.discordapp.com/emojis/1441333039941812224.png'
};

// 分類顏色映射
const CATEGORY_COLORS = {
  '活動': 0xd9912b,  // 橘色 #d9912b
  '維修': 0x993d3d,  // 紅色 #993d3d
  '維護': 0x993d3d,  // 紅色 #993d3d（同義詞）
  '公告': 0x6BCF7F,  // 綠色
  '更新': 0x6b993d,  // 深綠色 #6b993d
  '其他': 0xcccccc   // 淺灰色 #cccccc
};

// ==================== 工具函數 ====================

/**
 * 延遲函數
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 格式化觀看數（加入千分位）
 */
function formatViews(views) {
  return views.toLocaleString('en-US');
}

/**
 * 解析日期字串為 ISO 8601 格式
 * @param {string} dateString - "2025-11-18" 格式
 * @returns {string} ISO 8601 格式的日期字串
 */
function parseDate(dateString) {
  // API 回傳的日期格式是 "YYYY-MM-DD"，假設為台灣時區的日期
  // 轉換為 UTC 時間（台灣時間 00:00 = UTC 前一天 16:00）
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(year, month - 1, day, 0, 0, 0);
  return date.toISOString();
}

/**
 * 取得分類圖示
 */
function getCategoryIcon(category) {
  return CATEGORY_ICONS[category] || CATEGORY_ICONS['其他'];
}

/**
 * 取得分類顏色
 */
function getCategoryColor(category) {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS['其他'];
}

// ==================== KV 新聞資料讀取 ====================

/**
 * 從 KV 讀取新聞資料
 * @param {Object} env - Cloudflare Worker 環境變數
 * @returns {Object} 新聞資料（與原 API 格式相同）
 */
async function loadNewsFromKV(env) {
  try {
    const data = await env.ffxivnews.get(NEWS_KV_KEY, { type: 'json' });

    if (!data) {
      throw new Error('KV 中沒有新聞資料');
    }

    return data;
  } catch (error) {
    console.error('✗ 無法讀取新聞資料:', error.message);
    throw error;
  }
}

/**
 * 展平分類結構，將所有文章收集到單一陣列
 * @param {Object} categories - API 回傳的 categories 物件
 * @returns {Array} 文章陣列，每個文章包含 category 欄位
 */
function collectAllArticles(categories) {
  const articles = [];

  for (const [category, items] of Object.entries(categories)) {
    for (const item of items) {
      articles.push({
        ...item,
        category: category
      });
    }
  }

  return articles;
}

// ==================== KV 狀態管理 ====================

/**
 * 從 KV 載入快照（上次的完整 ID 清單）
 * @returns {Promise<Array<string>>} 文章 ID 清單
 */
async function loadSnapshot(env) {
  try {
    const data = await env.RSS_CACHE.get(KV_SNAPSHOT_KEY, { type: 'json' });
    if (!data || !data.articleIds) {
      return [];
    }
    return data.articleIds;
  } catch (error) {
    return [];
  }
}

/**
 * 儲存快照（當前的完整 ID 清單）到 KV
 * @param {Object} env - 環境變數
 * @param {Array<string>} articleIds - 文章 ID 清單
 */
async function saveSnapshot(env, articleIds) {
  try {
    const data = {
      updatedAt: new Date().toISOString(),
      articleIds: articleIds
    };

    await env.RSS_CACHE.put(
      KV_SNAPSHOT_KEY,
      JSON.stringify(data),
      { expirationTtl: SNAPSHOT_TTL_SECONDS }
    );
  } catch (error) {
    console.error('✗ 快照儲存失敗:', error.message);
    throw error;
  }
}

/**
 * 從 KV 載入 sent map
 * @returns {Map<string, Object>} sent map (key: article ID, value: metadata)
 */
async function loadSentMap(env) {
  try {
    const data = await env.RSS_CACHE.get(KV_SENT_MAP_KEY, { type: 'json' });
    if (!data) {
      return new Map();
    }
    return new Map(Object.entries(data));
  } catch (error) {
    return new Map();
  }
}

/**
 * 儲存 sent map 到 KV
 */
async function saveSentMap(env, sentMap) {
  try {
    // 容量管理：如果超過 500 筆，刪除最舊的記錄
    if (sentMap.size > MAX_SENT_MAP_SIZE) {
      await pruneSentMap(sentMap);
    }

    // 轉換 Map 為 Object
    const data = Object.fromEntries(sentMap);

    await env.RSS_CACHE.put(
      KV_SENT_MAP_KEY,
      JSON.stringify(data),
      { expirationTtl: SENT_MAP_TTL_SECONDS }
    );
  } catch (error) {
    console.error('✗ KV 儲存失敗:', error.message);
    throw error;
  }
}

/**
 * 清理 sent map，保留最新的 500 筆記錄
 */
async function pruneSentMap(sentMap) {
  // 轉換為陣列並按 sentAt 排序
  const entries = Array.from(sentMap.entries());
  entries.sort((a, b) => {
    const timeA = new Date(a[1].sentAt).getTime();
    const timeB = new Date(b[1].sentAt).getTime();
    return timeB - timeA; // 降冪排序（最新的在前）
  });

  // 保留前 500 筆
  const toKeep = entries.slice(0, MAX_SENT_MAP_SIZE);
  const toDelete = entries.slice(MAX_SENT_MAP_SIZE);

  // 清除舊記錄
  for (const [id] of toDelete) {
    sentMap.delete(id);
  }
}

// ==================== Discord 推送 ====================

/**
 * 從文章頁面提取前三個段落作為描述
 * @param {string} url - 文章 URL
 * @returns {Promise<string>} 描述文字（最多 300 字元）
 */
async function fetchArticleDescription(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return '';
    }

    const paragraphs = [];
    let currentParagraphText = '';

    const rewriter = new HTMLRewriter()
      // 支援兩種結構：div.article > section > p 和 div.article > p
      .on('div.article p', {
        text(text) {
          // 累積當前段落的文字
          if (text.text.trim()) {
            currentParagraphText += text.text.trim();
          }
        },
        element(element) {
          // 當遇到新的 <p> 標籤時，儲存前一個段落
          if (currentParagraphText && paragraphs.length < 3) {
            paragraphs.push(currentParagraphText);
            currentParagraphText = '';
          } else if (!currentParagraphText) {
            // 重置，準備收集下一個段落
            currentParagraphText = '';
          }
        }
      });

    await rewriter.transform(response).text();

    // 處理最後一個段落
    if (currentParagraphText && paragraphs.length < 3) {
      paragraphs.push(currentParagraphText);
    }

    // 過濾掉空段落和只包含特殊字元的段落
    const filteredParagraphs = paragraphs
      .map(p => p.trim())
      .filter(p => p.length > 0 && p !== '<br>' && p !== ' ')
      .slice(0, 3); // 只取前三個有效段落

    // 組合段落，用換行分隔
    let description = filteredParagraphs.join('\n');

    // 截斷過長的描述
    const MAX_LENGTH = 300;
    if (description.length > MAX_LENGTH) {
      description = description.substring(0, MAX_LENGTH) + '...';
    }

    return description;
  } catch (error) {
    return '';
  }
}

/**
 * 建立 Discord Embed
 */
async function buildDiscordEmbed(article) {
  const icon = getCategoryIcon(article.category);
  const color = getCategoryColor(article.category);
  const timestamp = parseDate(article.date);

  // 從文章頁面提取描述
  const description = await fetchArticleDescription(article.url);

  const embed = {
    author: {
      name: article.category,
      icon_url: icon,
      url: article.url
    },
    title: article.title,
    url: article.url,
    color: color,
    thumbnail: {
      url: 'https://www.ffxiv.com.tw/web/images/news/news_content/avatar_01.png'
    },
    timestamp: timestamp,
    footer: {
      text: `FFXIV 官方網站`
    }
  };

  // 只有在有描述時才加入 description 欄位
  if (description) {
    embed.description = description;
  }

  return {
    embeds: [embed]
  };
}

/**
 * 發送單篇文章到 Discord
 */
async function sendToDiscord(webhook, article) {
  try {
    const payload = await buildDiscordEmbed(article);

    const response = await fetch(webhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Discord API error: ${response.status} ${errorText}`);
    }

    return true;
  } catch (error) {
    console.error(`✗ 發送失敗 [${article.id}] ${article.title}:`, error.message);
    return false;
  }
}

// ==================== 主處理邏輯 ====================

/**
 * 主處理函數
 * @param {Object} env - Cloudflare Worker 環境變數
 * @param {boolean} testMode - 測試模式（僅發送最新一篇）
 */
async function processFFXIVNews(env, testMode = false) {
  console.log(`[${new Date().toISOString()}] FFXIV News Monitor ${testMode ? '(Test Mode)' : ''}`);

  try {
    // 1. 檢查環境變數
    const webhook = env.DISCORD_WEBHOOK_FFXIV_TW_NEWS;
    if (!webhook) {
      throw new Error('環境變數 DISCORD_WEBHOOK_FFXIV_TW_NEWS 未設定');
    }

    // 2. 從 KV 讀取新聞資料
    const newsData = await loadNewsFromKV(env);
    const allArticles = collectAllArticles(newsData.categories);
    const currentIds = allArticles.map(article => article.id);

    // 3. 載入快照（上次的完整 ID 清單）
    const previousIds = await loadSnapshot(env);
    const isFirstRun = previousIds.length === 0;

    if (isFirstRun) {
      console.log('⚠️  首次執行：記錄所有文章但不發送');
    }

    // 4. 比對快照，找出新增的文章 ID
    const newIds = currentIds.filter(id => !previousIds.includes(id));
    const newArticles = allArticles.filter(article => newIds.includes(article.id));

    if (newArticles.length === 0) {
      console.log(`✓ 無新文章 (${allArticles.length} 篇)`);
      return;
    }

    console.log(`發現 ${newArticles.length} 篇新文章`);

    // 5. 按日期排序（舊到新）
    newArticles.sort((a, b) => {
      return new Date(a.date) - new Date(b.date);
    });

    // 6. 測試模式：僅處理最新一篇
    let articlesToProcess = newArticles;
    if (testMode && newArticles.length > 0) {
      articlesToProcess = [newArticles[newArticles.length - 1]];
      console.log('→ 測試模式：僅發送最新一篇');
    }

    // 7. 載入 sent map（用於記錄發送歷史）
    const sentMap = await loadSentMap(env);

    // 8. 處理文章（首次執行只記錄，不發送）
    let successCount = 0;

    for (const article of articlesToProcess) {
      if (isFirstRun) {
        // 首次執行：只記錄 ID，不發送
        sentMap.set(article.id, {
          sentAt: new Date().toISOString(),
          category: article.category,
          title: article.title
        });
        successCount++;
      } else {
        // 正常執行：發送到 Discord
        const success = await sendToDiscord(webhook, article);

        if (success) {
          sentMap.set(article.id, {
            sentAt: new Date().toISOString(),
            category: article.category,
            title: article.title
          });
          successCount++;

          // 避免 Discord rate limit
          if (articlesToProcess.indexOf(article) < articlesToProcess.length - 1) {
            await sleep(1000);
          }
        }
      }
    }

    // 9. 儲存 sent map（發送歷史）
    await saveSentMap(env, sentMap);

    // 10. 更新快照（首次執行必須更新，非首次執行只在非測試模式時更新）
    if (isFirstRun || !testMode) {
      await saveSnapshot(env, currentIds);
    } else {
      console.log('⚠️  測試模式：快照未更新');
    }

    // 11. 總結
    console.log(`✓ 完成：${successCount}/${articlesToProcess.length} 篇${isFirstRun ? '已記錄' : '已發送'}`);

  } catch (error) {
    console.error('✗ 執行失敗:', error.message);
    throw error;
  }
}

// ==================== Worker 進入點 ====================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 測試端點: 手動觸發
    if (url.pathname === '/trigger') {
      try {
        await processFFXIVNews(env, true); // testMode = true
        return new Response('✓ 手動觸發完成（測試模式）', {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      } catch (error) {
        return new Response(`✗ 執行失敗: ${error.message}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    }

    // 狀態查詢端點
    if (url.pathname === '/status') {
      try {
        const snapshot = await loadSnapshot(env);
        const sentMap = await loadSentMap(env);
        const stats = {
          快照文章數: snapshot.length,
          發送歷史數: sentMap.size,
          最大歷史容量: MAX_SENT_MAP_SIZE,
          snapshot_key: KV_SNAPSHOT_KEY,
          sent_map_key: KV_SENT_MAP_KEY,
          news_kv_binding: 'ffxivnews',
          news_kv_key: NEWS_KV_KEY
        };

        return new Response(JSON.stringify(stats, null, 2), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (error) {
        return new Response(`✗ 查詢失敗: ${error.message}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    }

    // 清除 KV 端點（僅供除錯使用）
    if (url.pathname === '/clearkv') {
      try {
        await env.RSS_CACHE.delete(KV_SNAPSHOT_KEY);
        await env.RSS_CACHE.delete(KV_SENT_MAP_KEY);
        return new Response('✓ 快照和發送歷史已清除', {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      } catch (error) {
        return new Response(`✗ 清除失敗: ${error.message}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    }

    return new Response('FFXIV 台灣官網新聞監控 Worker 運作中', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processFFXIVNews(env, false)); // testMode = false
  }
};
