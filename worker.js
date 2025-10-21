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
 * 
 * 2. Workers Cron Triggers (在 Cloudflare Dashboard 設定):
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
    thumbnailStrategy: 'page'
  },
  {
    url: 'https://www.4gamers.com.tw/rss/latest-news',
    name: '4Gamers',
    baseUrl: 'https://www.4gamers.com.tw',
    color: 0x3A94CB,
    webhookEnv: 'DISCORD_WEBHOOK_4GAMERS',
    thumbnailStrategy: 'rss'
  }
];

// 近期已處理連結快取，避免短時間重複推送
const RECENT_LINK_CACHE = new Map();
const RECENT_LINK_TTL_MS = 10 * 60 * 1000; // 10 分鐘

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
    // 決定每個源要處理幾篇文章
    const limitPerSource = testMode ? 1 : 5;
    
    // 遍歷所有 RSS 源
    for (const source of RSS_SOURCES) {
      console.log(`Processing RSS source: ${source.name}`);
      
      try {
        // 抓取 RSS
        const response = await fetch(source.url);
        if (!response.ok) {
          console.error(`Failed to fetch ${source.name}: ${response.status}`);
          continue;  // 跳過這個源,繼續處理下一個
        }
        
        const rssText = await response.text();
        
        // 解析 RSS (只處理需要的數量)
        let items = await parseRSSItems(rssText, source, limitPerSource);
        console.log(`Items parsed for ${source.name}: ${items.length}`);
        if (testMode && items.length > 1) {
          items = items.slice(0, 1);
        }

        const webhookUrl = env[source.webhookEnv];
        if (!webhookUrl) {
          console.warn(`Missing webhook env for ${source.name}: ${source.webhookEnv}`);
          continue;
        }

        const freshItems = items.filter(item => {
          if (!item.link) {
            console.warn(`Skip item without link from ${source.name}`);
            return false;
          }
          if (isRecentlyProcessed(item.link)) {
            console.log(`Skip duplicate item (recent cache): ${item.link}`);
            return false;
          }
          return true;
        });

        if (!freshItems.length) {
          console.log(`No new items for ${source.name}`);
          continue;
        }
        
        // 推送到 Discord
        for (const item of freshItems) {
          await sendToDiscord(webhookUrl, item);
          // 避免超過 Discord rate limit,每篇間隔 1 秒
          await sleep(1000);
        }
        
        console.log(`Successfully processed ${freshItems.length} items from ${source.name}${testMode ? ' (test mode)' : ''}`);
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
 */
async function parseRSSItems(rssXml, source, limit = 5) {
  const items = [];
  const seenLinks = new Set();
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

  for (const match of rssXml.matchAll(itemRegex)) {
    if (items.length >= limit) {
      break;
    }

    const itemContent = match[1];
    const title = extractTagValue(itemContent, 'title') || 'No Title';
    const descriptionHtml = extractTagValue(itemContent, 'description');
    const link = extractTagValue(itemContent, 'link');
    const pubDate = extractTagValue(itemContent, 'pubDate');
    const contentHtml =
      extractTagValue(itemContent, 'content:encoded') ||
      extractTagValue(itemContent, 'encoded');

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
        console.log('Thumbnail from media:content:', thumbnail);
      } else if (descriptionHtml) {
        thumbnail = extractThumbnail(descriptionHtml, source.baseUrl);
        if (thumbnail) {
          console.log('Thumbnail from description:', thumbnail);
        }
      } else if (contentHtml) {
        thumbnail = extractThumbnail(contentHtml, source.baseUrl);
        if (thumbnail) {
          console.log('Thumbnail from content:encoded:', thumbnail);
        }
      }
    } else if (source.thumbnailStrategy === 'page' && link) {
      console.log('Fetching article page for thumbnail:', link);
      thumbnail = await extractThumbnailFromPage(link, source.baseUrl);
    }

    items.push({
      title,
      description: cleanHtml(descriptionHtml),
      link,
      pubDate,
      thumbnail,
      source
    });
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
    console.log('Fetching article page:', url);
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
      
      console.log('Thumbnail extracted from page:', imgUrl);
      return imgUrl;
    }
    
    console.log('No image found in article page');
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

/**
 * 推送訊息到 Discord
 */
async function sendToDiscord(webhookUrl, item) {
  // 建立 embed 物件
  const embed = {
    title: item.title,
    description: item.description,
    url: item.link,
    color: item.source.color,  // 使用來源的顏色
    timestamp: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
    footer: {
      text: item.source.name  // 顯示來源名稱
    }
  };
  
  // 如果有縮圖,加入到 embed (使用 image 欄位顯示大圖)
  if (item.thumbnail) {
    embed.image = {
      url: item.thumbnail
    };
    console.log(`Thumbnail found: ${item.thumbnail}`);
  } else {
    console.log('No thumbnail found for:', item.title);
  }
  
  const payload = {
    embeds: [embed]
  };
  
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
  } else {
    console.log(`Successfully sent to Discord: ${item.title}`);
  }
}

/**
 * 延遲函數
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 檢查是否是近期已處理過的連結
 */
function isRecentlyProcessed(link) {
  if (!link) {
    return false;
  }
  
  const now = Date.now();
  
  // 清理過期快取
  for (const [cachedLink, timestamp] of RECENT_LINK_CACHE) {
    if (now - timestamp > RECENT_LINK_TTL_MS) {
      RECENT_LINK_CACHE.delete(cachedLink);
    }
  }
  
  if (RECENT_LINK_CACHE.has(link)) {
    return true;
  }
  
  RECENT_LINK_CACHE.set(link, now);
  return false;
}
