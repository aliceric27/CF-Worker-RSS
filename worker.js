/**
 * Multi-RSS to Discord Webhook Worker
 * 
 * 功能:
 * 1. 每小時自動抓取多個 RSS 源
 * 2. 解析縮圖 (從 description 或文章頁面提取)
 * 3. 推送到 Discord (使用 embed 格式)
 * 
 * 設定方式 (在 Cloudflare Dashboard):
 * 1. Environment Variables:
 *    - DISCORD_WEBHOOK_GNN: 巴哈姆特用 Webhook URL
 *    - DISCORD_WEBHOOK_4GAMERS: 4Gamers 用 Webhook URL
 *    - DISCORD_WEBHOOK_PTT_STEAM: PTT 限免資訊用 Webhook URL
 * 2. KV Namespace Bindings:
 *    - RSS_CACHE: 儲存已處理的文章連結,避免重複推送
 *
 * 3. Workers Cron Triggers (在 Cloudflare Dashboard 設定):
 *    - 在 Triggers > Cron Triggers 新增: 0 * * * *  (每小時執行一次)
 */

// RSS 源配置
const RSS_SOURCES = [
  {
    url: 'https://gnn.gamer.com.tw/rss.xml',
    name: '巴哈姆特 GNN 新聞網',
    baseUrl: 'https://gnn.gamer.com.tw',
    color: 0x009CAD,
    webhookEnv: 'DISCORD_WEBHOOK_GNN',
    thumbnailStrategy: 'page',
    descriptionMaxLength: 120
  },
  {
    url: 'https://www.4gamers.com.tw/rss/latest-news',
    name: '4Gamers',
    baseUrl: 'https://www.4gamers.com.tw',
    color: 0x3A94CB,
    webhookEnv: 'DISCORD_WEBHOOK_4GAMERS',
    thumbnailStrategy: 'rss'
  },
  {
    url: 'https://www.ptt.cc/atom/Steam.xml',
    name: 'PTT Steam 限免',
    baseUrl: 'https://www.ptt.cc',
    color: 0x0066CC,
    webhookEnv: 'DISCORD_WEBHOOK_PTT_STEAM',
    thumbnailStrategy: 'none',
    itemFilter: (item, context) => {
      const title = typeof item.title === 'string' ? item.title : '';
      if (title.includes('限免')) {
        return true;
      }

      const descriptionText = typeof item.description === 'string' ? item.description : '';
      if (descriptionText.includes('限免')) {
        return true;
      }

      const descriptionHtml = context && typeof context.descriptionHtml === 'string'
        ? context.descriptionHtml
        : '';

      return descriptionHtml.includes('限免');
    },
    buildPayload: article => ({ content: article.link || article.title || '限免資訊' })
  }
];

// 時區與批次設定
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8
const DAILY_TIMEZONE = 'Asia/Taipei';
const MAX_ITEMS_PER_SEND = 5;
const MAX_RSS_ITEMS = 50;
const SENT_MAP_TTL_SECONDS = 2 * 24 * 60 * 60;

function extractTagValue(content, tagName) {
  const escaped = tagName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const cdataRegex = new RegExp(`<${escaped}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${escaped}>`, 'i');
  const cdataMatch = cdataRegex.exec(content);
  if (cdataMatch) {
    return cdataMatch[1].trim();
  }

  const textRegex = new RegExp(`<${escaped}[^>]*>\\s*([\\s\\S]*?)\\s*<\\/${escaped}>`, 'i');
  const textMatch = textRegex.exec(content);
  return textMatch ? textMatch[1].trim() : '';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 手動觸發端點 (用於測試) - 只發布最新一篇
    if (url.pathname === '/trigger') {
      await processRSS(env, true);
      return new Response('RSS processing triggered manually (latest article only)', { status: 200 });
    }
    
    return new Response('GNN RSS Worker is running. Use /trigger to test manually.', { status: 200 });
  },

  // Cron trigger - 每小時執行
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processRSS(env, false));
  }
};

/**
 * 處理 RSS 抓取和推送邏輯
 * @param {Object} env - 環境變數
 * @param {boolean} testMode - 測試模式 (每個源只發布最新一篇)
 */
async function processRSS(env, testMode = false) {
  try {
    const kv = env.RSS_CACHE;
    if (!kv) {
      console.error('RSS_CACHE KV namespace 未綁定,無法執行每日聚合');
      return;
    }

    const dateKey = getTaipeiDateKey(new Date());
    const sendLimit = testMode ? 1 : MAX_ITEMS_PER_SEND;

    for (const source of RSS_SOURCES) {
      try {
        const webhookUrl = env[source.webhookEnv];
        if (!webhookUrl) {
          console.error(`缺少 ${source.name} 的 Webhook 設定: ${source.webhookEnv}`);
          continue;
        }

        const { key, state, exists } = await loadDailyState(kv, source, dateKey);
        const { key: sentKey, map: sentMap } = await loadSentMap(kv, source);
        let sentMapDirty = pruneSentMap(sentMap);

        // 抓取 RSS
        const response = await fetch(source.url);
        if (!response.ok) {
          console.error(`Failed to fetch ${source.name}: ${response.status}`);
          continue;  // 跳過這個源,繼續處理下一個
        }
        
        const rssText = await response.text();

        const parsedItems = await parseRSSItems(rssText, source, dateKey);
        const { articles, hasChanges } = mergeArticles(state.articles, parsedItems);

        const alreadySentUpdated = markPreviouslySentArticles(articles, sentMap);

        // 尋找尚未發送的文章 (由舊到新)
        const unsentQueue = articles.filter(article => !article.sent);
        const toSend = unsentQueue.slice(0, sendLimit);

        let sendSuccess = false;
        if (toSend.length) {
          let successCount = 0;

          for (const article of toSend) {
            const sent = await sendToDiscord(webhookUrl, article, source);
            if (sent) {
              article.sent = true;
              article.sentAt = new Date().toISOString();
              if (setSentEntry(sentMap, article)) {
                sentMapDirty = true;
              }
              successCount += 1;
              sendSuccess = true;
            }
            // 避免超過 Discord rate limit,每篇間隔 1 秒
            await sleep(1000);
          }

          console.log(`Successfully sent ${successCount}/${toSend.length} items for ${source.name}${testMode ? ' (test mode)' : ''}`);
        } else {
          console.log(`No pending items to send for ${source.name}`);
        }

        if (hasChanges || sendSuccess || alreadySentUpdated || !exists) {
          const nextState = {
            ...state,
            articles,
            updatedAt: new Date().toISOString()
          };
          await saveDailyState(kv, key, nextState);
        }

        if (sentMapDirty) {
          await saveSentMap(kv, sentKey, sentMap);
        }
      } catch (error) {
        console.error(`Error processing ${source.name}:`, error);
        // 繼續處理下一個源
      }
    }
  } catch (error) {
    console.error('Error in processRSS:', error);
  }
}

/**
 * 解析 RSS XML 並提取文章資訊
 * @param {string} rssXml - RSS XML 內容
 * @param {Object} source - RSS 源資訊
 * @param {number} limit - 限制處理的文章數量
 * @param {Object} env - 環境變數 (用於 KV 去重)
 */
async function parseRSSItems(rssXml, source, targetDateKey) {
  const items = [];
  const seenLinks = new Set();
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  const filter = typeof source.itemFilter === 'function' ? source.itemFilter : null;

  const rssMatches = Array.from(rssXml.matchAll(itemRegex)).map(match => ({ kind: 'rss', content: match[1] }));
  const atomMatches = Array.from(rssXml.matchAll(entryRegex)).map(match => ({ kind: 'atom', content: match[1] }));
  const records = rssMatches.length ? rssMatches : atomMatches;

  for (const record of records) {
    if (items.length >= MAX_RSS_ITEMS) {
      break;
    }

    const itemContent = record.content;

    let title = 'No Title';
    let descriptionHtml = '';
    let link = '';
    let pubDate = '';
    let guid = '';
    let contentHtml = '';

    if (record.kind === 'atom') {
      title = extractTagValue(itemContent, 'title') || 'No Title';
      descriptionHtml = extractTagValue(itemContent, 'summary') || extractTagValue(itemContent, 'content') || '';
      link = extractAtomLink(itemContent) || '';
      pubDate = extractTagValue(itemContent, 'published') || extractTagValue(itemContent, 'updated') || '';
      guid = extractTagValue(itemContent, 'id') || link;
      contentHtml = descriptionHtml;
    } else {
      title = extractTagValue(itemContent, 'title') || 'No Title';
      descriptionHtml = extractTagValue(itemContent, 'description');
      link = extractTagValue(itemContent, 'link');
      pubDate = extractTagValue(itemContent, 'pubDate');
      guid = extractTagValue(itemContent, 'guid');
      contentHtml =
        extractTagValue(itemContent, 'content:encoded') ||
        extractTagValue(itemContent, 'encoded');
    }

    const descriptionText = limitPlainText(cleanHtml(descriptionHtml || ''), source.descriptionMaxLength);

    const publishedAt = parsePubDate(pubDate);
    if (!publishedAt) {
      continue;
    }

    const itemDateKey = getTaipeiDateKey(publishedAt);
    if (itemDateKey !== targetDateKey) {
      continue;
    }

    if (link && seenLinks.has(link)) {
      continue;
    }
    if (link) {
      seenLinks.add(link);
    }

    let thumbnail = null;
    if (source.thumbnailStrategy === 'rss') {
      const mediaMatch = /<media:content[^>]*url=["']([^"']+)["'][^>]*>/i.exec(itemContent);
      const mediaUrl = mediaMatch ? mediaMatch[1].trim() : '';
      if (mediaUrl) {
        thumbnail = mediaUrl;
      } else if (descriptionHtml) {
        thumbnail = extractThumbnail(descriptionHtml, source.baseUrl);
      } else if (contentHtml) {
        thumbnail = extractThumbnail(contentHtml, source.baseUrl);
      }
    } else if (source.thumbnailStrategy === 'page' && link) {
      thumbnail = await extractThumbnailFromPage(link, source.baseUrl);
    }

    const nextItem = {
      title,
      description: descriptionText,
      link,
      guid,
      thumbnail,
      publishedAt: publishedAt.toISOString(),
      publishedAtMs: publishedAt.getTime()
    };

    if (filter && !filter(nextItem, { descriptionHtml, contentHtml })) {
      continue;
    }

    items.push(nextItem);
  }
  
  return items;
}

/**
 * 從文章頁面提取縮圖
 * @param {string} url - 文章 URL
 * @param {string} baseUrl - 網站基礎 URL (用於補全相對路徑)
 */
async function extractThumbnailFromPage(url, baseUrl) {
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`Failed to fetch article page: ${response.status}`);
      return null;
    }
    
    const html = await response.text();
    
    // 尋找文章內的第一張圖片
    // 優先找 data-src (懶加載圖片)
    let imgMatch = /<img[^>]*data-src=["']([^"']+)["'][^>]*>/i.exec(html);
    
    if (!imgMatch) {
      // 如果沒有 data-src,找一般的 src
      imgMatch = /<img[^>]*src=["']([^"']+)["'][^>]*>/i.exec(html);
    }
    
    if (imgMatch && imgMatch[1]) {
      let imgUrl = imgMatch[1];
      
      // 移除查詢參數
      imgUrl = imgUrl.split('?')[0];
      
      // 確保是完整 URL
      if (imgUrl.startsWith('//')) {
        imgUrl = 'https:' + imgUrl;
      } else if (imgUrl.startsWith('/')) {
        imgUrl = baseUrl + imgUrl;
      }
      
      return imgUrl;
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting thumbnail from page:', error);
    return null;
  }
}

/**
 * 從 HTML 描述中提取第一張圖片 URL
 * @param {string} html - HTML 內容
 * @param {string} baseUrl - 網站基礎 URL (用於補全相對路徑)
 */
function extractThumbnail(html, baseUrl) {
  // 尋找 <img> 標籤 (支援多種屬性格式)
  const imgTagRegex = /<img[^>]*>/i;
  const imgTagMatch = imgTagRegex.exec(html);
  
  if (!imgTagMatch) {
    return null;
  }
  
  const imgTag = imgTagMatch[0];
  let imgUrl = null;
  
  // 優先順序: data-src > src > data-srcset (取第一個 URL)
  // 1. 嘗試提取 data-src
  const dataSrcMatch = /data-src=["']([^"']+)["']/i.exec(imgTag);
  if (dataSrcMatch && dataSrcMatch[1]) {
    imgUrl = dataSrcMatch[1];
  }
  
  // 2. 如果沒有 data-src,嘗試提取 src
  if (!imgUrl) {
    const srcMatch = /src=["']([^"']+)["']/i.exec(imgTag);
    if (srcMatch && srcMatch[1]) {
      imgUrl = srcMatch[1];
    }
  }
  
  // 3. 如果都沒有,嘗試從 data-srcset 提取第一個 URL
  if (!imgUrl) {
    const dataSrcsetMatch = /data-srcset=["']([^"']+)["']/i.exec(imgTag);
    if (dataSrcsetMatch && dataSrcsetMatch[1]) {
      // srcset 格式: "url1 1x, url2 2x" - 取第一個 URL
      const firstUrl = dataSrcsetMatch[1].split(',')[0].trim().split(' ')[0];
      imgUrl = firstUrl;
    }
  }
  
  if (!imgUrl) {
    return null;
  }
  
  // 移除查詢參數中的時間戳 (保持 URL 穩定)
  imgUrl = imgUrl.split('?')[0];
  
  // 確保 URL 是完整的
  if (imgUrl.startsWith('//')) {
    imgUrl = 'https:' + imgUrl;
  } else if (imgUrl.startsWith('/')) {
    imgUrl = baseUrl + imgUrl;
  }
  
  return imgUrl;
}

/**
 * 清理 HTML 標籤,保留純文字
 */
function cleanHtml(html) {
  // 移除所有 HTML 標籤
  let text = html.replace(/<[^>]*>/g, '');
  
  // 解碼 HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&hellip;/g, '…');
  
  // 移除多餘空白
  text = text.replace(/\s+/g, ' ').trim();
  
  // 限制長度 (Discord embed description 最多 4096 字元)
  if (text.length > 300) {
    text = text.substring(0, 297) + '...';
  }
  
  return text;
}

function limitPlainText(text, maxLength) {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return text;
  }

  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 3) {
    return '.'.repeat(Math.max(1, maxLength));
  }

  const truncated = text.slice(0, maxLength - 3).trimEnd();
  return `${truncated}...`;
}

function extractAtomLink(entryContent) {
  const alternateMatch = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(entryContent);
  if (alternateMatch) {
    return alternateMatch[1];
  }

  const anyMatch = /<link[^>]*href=["']([^"']+)["'][^>]*>/i.exec(entryContent);
  return anyMatch ? anyMatch[1] : '';
}

function parsePubDate(pubDate) {
  if (!pubDate) {
    return null;
  }

  const publishedAt = new Date(pubDate);
  const time = publishedAt.getTime();
  return Number.isNaN(time) ? null : publishedAt;
}

function getTaipeiDateKey(date) {
  const timestamp = date.getTime();
  const taipeiTime = new Date(timestamp + TAIPEI_OFFSET_MS);
  const year = taipeiTime.getUTCFullYear();
  const month = String(taipeiTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(taipeiTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDailyKey(source, dateKey) {
  const identifier = source.webhookEnv || source.url || source.name;
  return `daily:${encodeURIComponent(identifier)}:${dateKey}`;
}

function buildSentCollectionKey(source) {
  const identifier = source.webhookEnv || source.url || source.name;
  return `sent:${encodeURIComponent(identifier)}`;
}

function getArticleIdentity(article) {
  if (article.guid && typeof article.guid === 'string' && article.guid.trim()) {
    return article.guid.trim();
  }
  if (article.link && typeof article.link === 'string' && article.link.trim()) {
    return article.link.trim();
  }
  return null;
}

function hashIdentifier(input) {
  const value = String(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function setSentEntry(sentMap, article) {
  const identity = getArticleIdentity(article);
  if (!identity) {
    return false;
  }

  const hash = hashIdentifier(identity);
  const sentAt = typeof article.sentAt === 'string' ? article.sentAt : new Date().toISOString();
  const prev = sentMap.get(hash);

  if (prev && prev.sentAt === sentAt) {
    return false;
  }

  sentMap.set(hash, {
    sentAt,
    identity
  });

  return true;
}

async function loadSentMap(kv, source) {
  const key = buildSentCollectionKey(source);
  const map = new Map();

  try {
    const raw = await kv.get(key);
    if (!raw) {
      return { key, map };
    }

    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      for (const [hash, entry] of Object.entries(data)) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const sentAt = typeof entry.sentAt === 'string' ? entry.sentAt : null;
        if (!sentAt) {
          continue;
        }
        map.set(hash, {
          sentAt,
          identity: typeof entry.identity === 'string' ? entry.identity : null
        });
      }
    }
  } catch (error) {
    console.error('讀取跨日去重資料失敗:', error);
  }

  return { key, map };
}

async function saveSentMap(kv, key, sentMap) {
  const serializable = {};

  for (const [hash, entry] of sentMap.entries()) {
    serializable[hash] = entry;
  }

  try {
    await kv.put(key, JSON.stringify(serializable), { expirationTtl: SENT_MAP_TTL_SECONDS });
  } catch (error) {
    console.error('寫入跨日去重資料失敗:', error);
  }
}

function pruneSentMap(sentMap) {
  const cutoffMs = Date.now() - (SENT_MAP_TTL_SECONDS * 1000);
  let mutated = false;

  for (const [hash, entry] of sentMap.entries()) {
    if (!entry || typeof entry.sentAt !== 'string') {
      sentMap.delete(hash);
      mutated = true;
      continue;
    }

    const timestamp = Date.parse(entry.sentAt);
    if (!Number.isFinite(timestamp) || timestamp < cutoffMs) {
      sentMap.delete(hash);
      mutated = true;
    }
  }

  return mutated;
}

async function loadDailyState(kv, source, dateKey) {
  const key = buildDailyKey(source, dateKey);
  const emptyState = {
    sourceName: source.name,
    sourceUrl: source.url,
    sourceId: source.webhookEnv || source.url,
    dateKey,
    timezone: DAILY_TIMEZONE,
    articles: [],
    updatedAt: new Date().toISOString()
  };

  try {
    const raw = await kv.get(key);
    if (!raw) {
      return { key, exists: false, state: emptyState };
    }

    const data = JSON.parse(raw);
    const rawArticles = Array.isArray(data.articles) ? data.articles : [];

    const articles = rawArticles
      .map(entry => {
        if (!entry || !entry.link) {
          return null;
        }

        const publishedAtMs = Number.isFinite(entry.publishedAtMs)
          ? Number(entry.publishedAtMs)
          : (entry.publishedAt ? Date.parse(entry.publishedAt) : null);

        return {
          link: entry.link,
          title: entry.title || 'No Title',
          description: entry.description || '',
          thumbnail: entry.thumbnail || null,
          guid: typeof entry.guid === 'string' ? entry.guid : null,
          publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : (publishedAtMs ? new Date(publishedAtMs).toISOString() : null),
          publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : null,
          sent: Boolean(entry.sent),
          sentAt: typeof entry.sentAt === 'string' ? entry.sentAt : null
        };
      })
      .filter(Boolean);

    return {
      key,
      exists: true,
      state: {
        sourceName: data.sourceName || source.name,
        sourceUrl: data.sourceUrl || source.url,
        sourceId: data.sourceId || source.webhookEnv || source.url,
        dateKey,
        timezone: data.timezone || DAILY_TIMEZONE,
        articles,
        updatedAt: data.updatedAt || new Date().toISOString()
      }
    };
  } catch (error) {
    console.error(`讀取每日 KV 資料失敗 (${source.name}):`, error);
    return { key, exists: false, state: emptyState };
  }
}

async function saveDailyState(kv, key, state) {
  try {
    await kv.put(key, JSON.stringify(state));
  } catch (error) {
    console.error('寫入每日 KV 資料失敗:', error);
  }
}

function mergeArticles(existingArticles, newItems) {
  const articleMap = new Map();

  for (const article of existingArticles) {
    if (!article.link) {
      continue;
    }

    articleMap.set(article.link, {
      ...article,
      sent: Boolean(article.sent),
      sentAt: article.sentAt || null,
      guid: typeof article.guid === 'string' ? article.guid : null,
      publishedAtMs: Number.isFinite(article.publishedAtMs)
        ? article.publishedAtMs
        : (article.publishedAt ? Date.parse(article.publishedAt) : null),
      publishedAt: article.publishedAt || (article.publishedAtMs ? new Date(article.publishedAtMs).toISOString() : null)
    });
  }

  let hasChanges = false;

  for (const item of newItems) {
    if (!item.link) {
      continue;
    }

    const existing = articleMap.get(item.link);
    if (existing) {
      let updated = false;
      const next = { ...existing };

      if (item.title && item.title !== existing.title) {
        next.title = item.title;
        updated = true;
      }
      if (item.description && item.description !== existing.description) {
        next.description = item.description;
        updated = true;
      }
      if (item.thumbnail && item.thumbnail !== existing.thumbnail) {
        next.thumbnail = item.thumbnail;
        updated = true;
      }
      if (item.guid && item.guid !== existing.guid) {
        next.guid = item.guid;
        updated = true;
      }
      if (item.publishedAt && item.publishedAt !== existing.publishedAt) {
        next.publishedAt = item.publishedAt;
        next.publishedAtMs = item.publishedAtMs;
        updated = true;
      }

      if (updated) {
        articleMap.set(item.link, next);
        hasChanges = true;
      }
    } else {
      articleMap.set(item.link, {
        link: item.link,
        title: item.title,
        description: item.description,
        thumbnail: item.thumbnail,
        guid: item.guid || null,
        publishedAt: item.publishedAt,
        publishedAtMs: item.publishedAtMs,
        sent: false,
        sentAt: null
      });
      hasChanges = true;
    }
  }

  const articles = Array.from(articleMap.values()).sort((a, b) => {
    const aTime = Number.isFinite(a.publishedAtMs) ? a.publishedAtMs : Number.POSITIVE_INFINITY;
    const bTime = Number.isFinite(b.publishedAtMs) ? b.publishedAtMs : Number.POSITIVE_INFINITY;
    if (aTime !== bTime) {
      return aTime - bTime;
    }
    return a.link.localeCompare(b.link);
  });

  return { articles, hasChanges };
}

function markPreviouslySentArticles(articles, sentMap) {
  let mutated = false;

  for (const article of articles) {
    if (article.sent) {
      continue;
    }

    const identity = getArticleIdentity(article);
    if (!identity) {
      continue;
    }

    const hash = hashIdentifier(identity);
    const entry = sentMap.get(hash);
    if (!entry) {
      continue;
    }

    article.sent = true;
    mutated = true;

    if (!article.sentAt && entry.sentAt) {
      article.sentAt = entry.sentAt;
    }
  }

  return mutated;
}


/**
 * 推送訊息到 Discord
 */
async function sendToDiscord(webhookUrl, item, source) {
  let payload = null;

  if (typeof source.buildPayload === 'function') {
    const customPayload = source.buildPayload(item, source);
    if (customPayload && typeof customPayload === 'object') {
      payload = customPayload;
    }
  }

  if (!payload) {
    // 建立 embed 物件
    const embed = {
      title: item.title,
      description: item.description,
      url: item.link,
      color: source.color,  // 使用來源的顏色
      timestamp: item.publishedAt || new Date().toISOString(),
      footer: {
        text: source.name  // 顯示來源名稱
      }
    };
    
    // 如果有縮圖,加入到 embed (使用 image 欄位顯示大圖)
    if (item.thumbnail) {
      embed.image = {
        url: item.thumbnail
      };
    }
    
    payload = {
      embeds: [embed]
    };
  }
  
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Failed to send to Discord: ${response.status} - ${errorText}`);
    return false;
  }

  return true;
}

/**
 * 延遲函數
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
