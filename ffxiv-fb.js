/**
 * FINAL FANTASY XIV RSS to Discord Webhook Worker
 *
 * Features:
 * 1. Fetches RSS feed every 2 hours via Cron Trigger
 * 2. Uses AI to optimize article titles and descriptions (Cloudflare Workers AI)
 * 3. Dual KV storage with smart TTL management:
 *    - Sent Map: 365 days TTL, max 500 entries (capacity-based pruning)
 *    - Daily State: 30 days TTL (preserves AI-optimized content)
 * 4. Sends Discord embed notifications (oldest first, max 5 per run)
 * 5. Prevents duplicate sends even with irregular posting schedules
 *
 * Setup (Cloudflare Dashboard):
 * 1. Environment Variables:
 *    - FFXIV_WEBHOOK: Discord webhook URL for FFXIV feed
 * 2. KV Namespace Bindings:
 *    - RSS_CACHE: Stores article metadata and sent history
 * 3. Workers AI Bindings (optional, for title/description optimization):
 *    - AI: Cloudflare Workers AI (@cf/openai/gpt-oss-120b)
 *
 * Storage Strategy:
 * - Sent map only prunes when exceeding 500 entries (removes oldest by sentAt)
 * - No time-based pruning to prevent duplicate sends during low-activity periods
 * - 500 entries ≈ 5 years of history at 2 posts/week
 */

const RSS_SOURCE = {
  url: 'https://fetchrss.com/feed/aQGiGCKvQd7yaQGh04DO3kVC.rss',
  name: 'FFXIV 官方 FB 粉絲團',
  baseUrl: 'https://www.facebook.com',
  color: 0x0866FF,
  thumbnailStrategy: 'rss',
  descriptionMaxLength: 300,
  useAITitle: true,  // 設為 true 啟用 AI 標題優化
  useAIDescription: true  // 設為 true 啟用 AI 描述優化
};

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8
const DAILY_TIMEZONE = 'Asia/Taipei';
const MAX_ITEMS_PER_SEND = 5;
const MAX_RSS_ITEMS = 50;
const SENT_MAP_TTL_SECONDS = 365 * 24 * 60 * 60; // 365 天 (KV 自動過期的安全網)
const DAILY_STATE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天
const MAX_SENT_MAP_SIZE = 500; // 最多保留 500 筆記錄 (主要清理機制)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trigger') {
      await processRSS(env, true);
      return new Response('FFXIV RSS processing triggered manually (latest article only)', { status: 200 });
    }
    if (url.pathname === '/triggerall') {
      await processAllRSS(env);
      return new Response('All RSS items sent to Discord (ignoring KV cache)', { status: 200 });
    }
    return new Response('FFXIV RSS worker is running. Use /trigger to test manually.', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processRSS(env, false));
  }
};

async function processRSS(env, testMode = false) {
  try {
    const kv = env.RSS_CACHE;
    if (!kv) {
      console.error('RSS_CACHE KV namespace not bound; unable to run aggregation');
      return;
    }

    const webhookUrl = env.FFXIV_WEBHOOK;
    if (!webhookUrl) {
      console.error('Missing webhook configuration: FFXIV_WEBHOOK');
      return;
    }

  const dateKey = getTaipeiDateKey(new Date());
  const sendLimit = testMode ? 1 : MAX_ITEMS_PER_SEND;

    try {
      // 設定全域 AI 綁定（如果有）
      if (env.AI) {
        globalThis.AI = env.AI;
      }

      const { key, state, exists } = await loadDailyState(kv, RSS_SOURCE, dateKey);
      const { key: sentKey, map: sentMap } = await loadSentMap(kv, RSS_SOURCE);
      let sentMapDirty = pruneSentMap(sentMap); // 清理過期記錄

      const response = await fetch(RSS_SOURCE.url);
      if (!response.ok) {
        console.error(`Failed to fetch FFXIV feed: ${response.status}`);
        return;
      }

      const rssText = await response.text();
      // 傳遞現有文章給 parseRSSItems,避免對已存在的文章重複調用 AI
      const parsedItems = await parseRSSItems(rssText, RSS_SOURCE, state.articles);
      const { articles, hasChanges } = mergeArticles(state.articles, parsedItems);
      const alreadySentUpdated = markPreviouslySentArticles(articles, sentMap);
      const unsentQueue = articles.filter(article => !article.sent);
      const toSend = unsentQueue.slice(0, sendLimit);

      let sendSuccess = false;
      if (toSend.length) {
        let successCount = 0;
        for (const article of toSend) {
          const sent = await sendToDiscord(webhookUrl, article, RSS_SOURCE);
          if (sent) {
            article.sent = true;
            article.sentAt = new Date().toISOString();
            if (setSentEntry(sentMap, article)) {
              sentMapDirty = true;
            }
            successCount += 1;
            sendSuccess = true;
          }
          await sleep(1000);
        }
        console.log(`Successfully sent ${successCount}/${toSend.length} items for ${RSS_SOURCE.name}${testMode ? ' (test mode)' : ''}`);
      } else {
        console.log(`No pending items to send for ${RSS_SOURCE.name}`);
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
      console.error(`Error processing ${RSS_SOURCE.name}:`, error);
    }
  } catch (error) {
    console.error('Fatal error in processRSS:', error);
  }
}

/**
 * Process all RSS items and send to Discord (ignoring KV cache)
 * @param {Object} env - Environment variables
 */
async function processAllRSS(env) {
  try {
    const webhookUrl = env.FFXIV_WEBHOOK;
    if (!webhookUrl) {
      console.error('Missing webhook configuration: FFXIV_WEBHOOK');
      return;
    }

    // 設定全域 AI 綁定（如果有）
    if (env.AI) {
      globalThis.AI = env.AI;
    }

    const response = await fetch(RSS_SOURCE.url);
    if (!response.ok) {
      console.error(`Failed to fetch FFXIV feed: ${response.status}`);
      return;
    }

    const rssText = await response.text();
    // /triggerall 會發送所有文章,因此不傳遞現有文章列表(會對所有項目調用 AI)
    const parsedItems = await parseRSSItems(rssText, RSS_SOURCE, []);

    // 按發佈時間排序:由舊到新
    const sortedItems = parsedItems.sort((a, b) => {
      const aTime = Number.isFinite(a.publishedAtMs) ? a.publishedAtMs : Number.POSITIVE_INFINITY;
      const bTime = Number.isFinite(b.publishedAtMs) ? b.publishedAtMs : Number.POSITIVE_INFINITY;
      return aTime - bTime;
    });

    console.log(`Found ${sortedItems.length} items in RSS feed. Sending all to Discord (oldest first)...`);

    let successCount = 0;
    for (const item of sortedItems) {
      const sent = await sendToDiscord(webhookUrl, item, RSS_SOURCE);
      if (sent) {
        successCount += 1;
      }
      // 避免超過 Discord rate limit
      await sleep(1000);
    }

    console.log(`Successfully sent ${successCount}/${sortedItems.length} items to Discord`);
  } catch (error) {
    console.error('Error in processAllRSS:', error);
  }
}

async function parseRSSItems(rssXml, source, existingArticles = []) {
  const items = [];
  const seenLinks = new Set();
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;

  // 建立現有文章的 Map,用於快速查找
  const existingArticleMap = new Map();
  for (const article of existingArticles) {
    if (article.link) {
      existingArticleMap.set(article.link, article);
    }
  }

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

    // 提取完整的純文字描述(用於 AI 處理)
    const fullDescriptionText = cleanHtmlForAI(descriptionHtml || '');
    
    // 只取前 2 個 <br> 之前的內容作為 Discord 顯示描述(如果不使用 AI)
    let descriptionForDisplay = descriptionHtml || '';
    const brMatches = descriptionForDisplay.match(/<br\s*\/?>/gi);
    if (brMatches && brMatches.length >= 2) {
      // 找到第二個 <br> 的位置
      let brCount = 0;
      let cutPosition = descriptionForDisplay.length;
      const brRegex = /<br\s*\/?>/gi;
      let match;
      while ((match = brRegex.exec(descriptionForDisplay)) !== null) {
        brCount++;
        if (brCount === 2) {
          cutPosition = match.index;
          break;
        }
      }
      descriptionForDisplay = descriptionForDisplay.substring(0, cutPosition);
    }
    const descriptionText = cleanHtml(descriptionForDisplay);

    const publishedAt = parsePubDate(pubDate);
    if (!publishedAt) {
      continue;
    }

    if (link && seenLinks.has(link)) {
      continue;
    }
    if (link) {
      seenLinks.add(link);
    }

    // 檢查文章是否已存在於 KV 中
    const existingArticle = existingArticleMap.get(link);
    let optimizedTitle = title;
    let optimizedDescription = descriptionText;

    if (existingArticle) {
      // 文章已存在,直接使用 KV 中保存的標題和描述(已經過 AI 優化)
      optimizedTitle = existingArticle.title || title;
      optimizedDescription = existingArticle.description || descriptionText;
    } else {
      // 新文章,調用 AI 優化
      if (source.useAITitle) {
        const aiTitle = await generateAITitle(title, fullDescriptionText);
        if (aiTitle) {
          optimizedTitle = aiTitle;
        }
      }

      if (source.useAIDescription) {
        const aiDescription = await generateAIDescription(fullDescriptionText);
        if (aiDescription) {
          optimizedDescription = aiDescription;
        }
      }
    }

    let thumbnail = null;
    if (source.thumbnailStrategy === 'rss') {
      // 提取 media:content 標籤的 url 屬性
      const mediaTagMatch = /<media:content[^>]*>/i.exec(itemContent);
      if (mediaTagMatch) {
        const mediaTag = mediaTagMatch[0];
        // 使用更寬鬆的正則來提取 URL（支援包含 & 等字元）
        const urlMatch = /url=["']([^"']+)["']/i.exec(mediaTag);
        if (urlMatch && urlMatch[1]) {
          // 解碼 HTML entities (&amp; -> &)
          let mediaUrl = urlMatch[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim();
          thumbnail = sanitizeImageUrl(mediaUrl, source.baseUrl);
        }
      }
      
      // 如果沒有 media:content，嘗試從 description 或 content 中提取
      if (!thumbnail && descriptionHtml) {
        thumbnail = extractThumbnail(descriptionHtml, source.baseUrl);
      }
      if (!thumbnail && contentHtml) {
        thumbnail = extractThumbnail(contentHtml, source.baseUrl);
      }
    } else if (source.thumbnailStrategy === 'page' && link) {
      thumbnail = await extractThumbnailFromPage(link, source.baseUrl);
    }

    const nextItem = {
      title: optimizedTitle,
      description: optimizedDescription,
      link,
      guid,
      thumbnail,
      publishedAt: publishedAt.toISOString(),
      publishedAtMs: publishedAt.getTime()
    };

    items.push(nextItem);
  }

  return items;
}

/**
 * 使用 Cloudflare AI 生成簡短的標題
 * @param {string} originalTitle - 原始標題
 * @param {string} description - 文章描述
 * @returns {Promise<string|null>} - 優化後的標題,失敗則返回 null
 */
async function generateAITitle(originalTitle, description) {
  try {
    // 如果沒有綁定 AI,直接返回
    if (!globalThis.AI) {
      return null;
    }

    const prompt = `請將以下 Facebook 貼文標題改寫為簡短、吸引人的標題(20字以內,繁體中文):

原始標題:${originalTitle}
內容摘要:${description}

要求:
1. 簡潔有力,突出重點
2. 保留關鍵資訊(如活動、獎勵、更新等)
3. 只輸出標題,不要其他說明`;

    const response = await globalThis.AI.run('@cf/openai/gpt-oss-120b', {
      instructions: 'You are a professional content editor specializing in creating concise, engaging titles.',
      input: prompt,
    });

    // AI 回應格式: response.output[1].content[0].text
    // output[0] 是 reasoning, output[1] 是 message
    if (response && Array.isArray(response.output) && response.output.length > 1) {
      const messageOutput = response.output[1];
      if (messageOutput && Array.isArray(messageOutput.content) && messageOutput.content.length > 0) {
        const textContent = messageOutput.content[0];
        if (textContent && textContent.text) {
          return textContent.text.trim();
        }
      }
    }

    return null;
  } catch (error) {
    console.error('AI title generation failed:', error);
    return null;
  }
}

/**
 * 使用 Cloudflare AI 生成簡短的描述
 * @param {string} originalDescription - 原始描述
 * @returns {Promise<string|null>} - 優化後的描述,失敗則返回 null
 */
async function generateAIDescription(originalDescription) {
  try {
    // 如果沒有綁定 AI,直接返回
    if (!globalThis.AI) {
      return null;
    }

    const prompt = `請將以下 Facebook 貼文內容改寫為簡短的摘要(80字以內,繁體中文):

原始內容:${originalDescription}

要求:
1. 簡潔明瞭,保留核心資訊
2. 適合作為 Discord 訊息預覽
3. 只輸出摘要,不要其他說明`;

    const response = await globalThis.AI.run('@cf/openai/gpt-oss-120b', {
      instructions: 'You are a professional content editor specializing in creating concise summaries.',
      input: prompt,
    });

    // AI 回應格式: response.output[1].content[0].text
    if (response && Array.isArray(response.output) && response.output.length > 1) {
      const messageOutput = response.output[1];
      if (messageOutput && Array.isArray(messageOutput.content) && messageOutput.content.length > 0) {
        const textContent = messageOutput.content[0];
        if (textContent && textContent.text) {
          return textContent.text.trim();
        }
      }
    }

    return null;
  } catch (error) {
    console.error('AI description generation failed:', error);
    return null;
  }
}

async function extractThumbnailFromPage(url, baseUrl) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch article page: ${response.status}`);
      return null;
    }
    const html = await response.text();
    let imgMatch = /<img[^>]*data-src=["']([^"']+)["'][^>]*>/i.exec(html);
    if (!imgMatch) {
      imgMatch = /<img[^>]*src=["']([^"']+)["'][^>]*>/i.exec(html);
    }
    if (imgMatch && imgMatch[1]) {
      return sanitizeImageUrl(imgMatch[1], baseUrl);
    }
    return null;
  } catch (error) {
    console.error('Error extracting thumbnail from page:', error);
    return null;
  }
}

function extractThumbnail(html, baseUrl) {
  const imgTagMatch = /<img[^>]*>/i.exec(html);
  if (!imgTagMatch) {
    return null;
  }
  const imgTag = imgTagMatch[0];
  let imgUrl = null;
  const dataSrcMatch = /data-src=["']([^"']+)["']/i.exec(imgTag);
  if (dataSrcMatch && dataSrcMatch[1]) {
    imgUrl = dataSrcMatch[1];
  }
  if (!imgUrl) {
    const srcMatch = /src=["']([^"']+)["']/i.exec(imgTag);
    if (srcMatch && srcMatch[1]) {
      imgUrl = srcMatch[1];
    }
  }
  if (!imgUrl) {
    const dataSrcsetMatch = /data-srcset=["']([^"']+)["']/i.exec(imgTag);
    if (dataSrcsetMatch && dataSrcsetMatch[1]) {
      const firstUrl = dataSrcsetMatch[1].split(',')[0].trim().split(' ')[0];
      imgUrl = firstUrl;
    }
  }
  if (!imgUrl) {
    return null;
  }
  return sanitizeImageUrl(imgUrl, baseUrl);
}

function sanitizeImageUrl(url, baseUrl) {
  let imgUrl = url;
  if (imgUrl.startsWith('//')) {
    imgUrl = 'https:' + imgUrl;
  } else if (imgUrl.startsWith('/')) {
    imgUrl = baseUrl + imgUrl;
  }
  return imgUrl;
}

function cleanHtml(html) {
  let text = html.replace(/<[^>]*>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&hellip;/g, '…');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 300) {
    text = text.substring(0, 297) + '...';
  }
  return text;
}

/**
 * 清理 HTML 內容供 AI 處理(保留完整文字,移除所有標籤和特殊元素)
 * @param {string} html - HTML 內容
 * @returns {string} - 純文字內容
 */
function cleanHtmlForAI(html) {
  // 移除 <img> 標籤
  let text = html.replace(/<img[^>]*>/gi, '');
  
  // 移除 <a> 標籤但保留文字
  text = text.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1');
  
  // 移除 <span> 標籤(如 FetchRSS 的版權聲明)
  text = text.replace(/<span[^>]*>.*?<\/span>/gi, '');
  
  // 將 <br> 轉換為空格
  text = text.replace(/<br\s*\/?>/gi, ' ');
  
  // 移除所有剩餘的 HTML 標籤
  text = text.replace(/<[^>]*>/g, '');
  
  // 解碼 HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&hellip;/g, '…');
  
  // 清理多餘空白
  text = text.replace(/\s+/g, ' ').trim();
  
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

function extractTagValue(content, tagName) {
  const escaped = tagName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const cdataRegex = new RegExp(`<${escaped}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${escaped}>`, 'i');
  const cdataMatch = cdataRegex.exec(content);
  if (cdataMatch) {
    return cdataMatch[1].trim();
  }
  const textRegex = new RegExp(`<${escaped}[^>]*>\\s*([\\s\\S]*?)\\s*</${escaped}>`, 'i');
  const textMatch = textRegex.exec(content);
  return textMatch ? textMatch[1].trim() : '';
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
  const identifier = source.url || source.name;
  return `daily:${encodeURIComponent(identifier)}:${dateKey}`;
}

function buildSentCollectionKey(source) {
  const identifier = source.url || source.name;
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
    console.error('Failed to load sent map:', error);
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
    console.error('Failed to persist sent map:', error);
  }
}

function pruneSentMap(sentMap) {
  let mutated = false;

  // 清理無效的記錄
  for (const [hash, entry] of sentMap.entries()) {
    if (!entry || typeof entry.sentAt !== 'string') {
      sentMap.delete(hash);
      mutated = true;
      continue;
    }
    const timestamp = Date.parse(entry.sentAt);
    if (!Number.isFinite(timestamp)) {
      sentMap.delete(hash);
      mutated = true;
    }
  }

  // 若超過容量上限，刪除最舊的記錄 (基於 sentAt 時間)
  if (sentMap.size > MAX_SENT_MAP_SIZE) {
    const sorted = Array.from(sentMap.entries())
      .sort((a, b) => Date.parse(a[1].sentAt) - Date.parse(b[1].sentAt));
    const toDelete = sorted.slice(0, sentMap.size - MAX_SENT_MAP_SIZE);
    for (const [hash] of toDelete) {
      sentMap.delete(hash);
    }
    mutated = true;
    console.log(`Pruned ${toDelete.length} old entries from sent map (exceeded ${MAX_SENT_MAP_SIZE} limit)`);
  }

  return mutated;
}

async function loadDailyState(kv, source, dateKey) {
  const key = buildDailyKey(source, dateKey);
  const emptyState = {
    sourceName: source.name,
    sourceUrl: source.url,
    sourceId: source.url,
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
          : entry.publishedAt
            ? Date.parse(entry.publishedAt)
            : null;
        return {
          link: entry.link,
          title: entry.title || 'No Title',
          description: entry.description || '',
          thumbnail: entry.thumbnail || null,
          guid: typeof entry.guid === 'string' ? entry.guid : null,
          publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : publishedAtMs ? new Date(publishedAtMs).toISOString() : null,
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
        sourceId: data.sourceId || source.url,
        dateKey,
        timezone: data.timezone || DAILY_TIMEZONE,
        articles,
        updatedAt: data.updatedAt || new Date().toISOString()
      }
    };
  } catch (error) {
    console.error(`Failed to load daily state (${source.name}):`, error);
    return { key, exists: false, state: emptyState };
  }
}

async function saveDailyState(kv, key, state) {
  try {
    await kv.put(key, JSON.stringify(state), { expirationTtl: DAILY_STATE_TTL_SECONDS });
  } catch (error) {
    console.error('Failed to persist daily state:', error);
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
        : article.publishedAt
          ? Date.parse(article.publishedAt)
          : null,
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
      
      // 如果新 item 有 AI 優化的標題,且與現有標題不同,才更新
      // 避免每次都更新相同標題造成不必要的 KV 寫入
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
      // 新文章直接加入(包含 AI 優化的標題)
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

async function sendToDiscord(webhookUrl, item, source) {
  const embed = {
    title: item.title,
    description: item.description,
    url: item.link,
    color: source.color,
    timestamp: item.publishedAt || new Date().toISOString(),
    footer: {
      text: source.name
    }
  };
  if (item.thumbnail) {
    embed.image = { url: item.thumbnail };
  }
  const payload = { embeds: [embed] };
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
