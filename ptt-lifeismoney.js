const LIFEISMONEY_URL = 'https://www.ptt.cc/bbs/Lifeismoney/index.html';
const LIFEISMONEY_BASE_URL = 'https://www.ptt.cc';
const LIFEISMONEY_SOURCE_ID = 'ptt-lifeismoney';

// Discord Webhook env var name (請在 Dashboard 綁定)
const LIFEISMONEY_WEBHOOK_ENV = 'DISCORD_WEBHOOK_LIFEISMONEY';

// 只針對推文數 >= 30 的文章發送通知
const PUSH_THRESHOLD = 30;

// 台北時區與 KV TTL 設定
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8
const DAILY_TTL_SECONDS = 2 * 24 * 60 * 60; // 2 天

// Discord 速率限制 (保守一秒一則)
const DISCORD_DELAY_MS = 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/trigger') {
      await processLifeismoney(env, true);
      return new Response('PTT Lifeismoney processing triggered manually', { status: 200 });
    }

    return new Response('PTT Lifeismoney worker is running. Use /trigger to test manually.', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    // 建議在 Dashboard 設定每 30 分鐘觸發一次
    ctx.waitUntil(processLifeismoney(env, false));
  }
};

async function processLifeismoney(env, testMode = false) {
  const kv = env.RSS_CACHE;
  if (!kv) {
    console.error('RSS_CACHE KV namespace 未綁定,無法儲存每日文章狀態');
    return;
  }

  const webhookUrl = env[LIFEISMONEY_WEBHOOK_ENV];
  if (!webhookUrl) {
    console.error(`缺少 Discord Webhook 設定: ${LIFEISMONEY_WEBHOOK_ENV}`);
    return;
  }

  const now = new Date();
  const dateKey = getTaipeiDateKey(now);

  try {
    const allEntries = await fetchAllTodayEntries(dateKey);

    console.log(`取得當日 (${dateKey}) 總文章數量: ${allEntries.length}`);

    const { state, key } = await loadDailyState(kv, dateKey);
    const mergedState = mergeState(state, allEntries);

    const toSend = selectArticlesToSend(mergedState, testMode);
    if (toSend.length === 0) {
      console.log('沒有符合條件且尚未發送的文章');
    } else {
      console.log(`準備發送 ${toSend.length} 篇文章到 Discord`);
      let successCount = 0;
      for (const article of toSend) {
        const sent = await sendToDiscord(webhookUrl, article);
        if (sent) {
          article.sent = true;
          article.sentAt = new Date().toISOString();
          successCount += 1;
        }
        await sleep(DISCORD_DELAY_MS);
      }
      console.log(`成功發送 ${successCount}/${toSend.length} 篇文章`);
    }

    mergedState.updatedAt = new Date().toISOString();
    await kv.put(key, JSON.stringify(mergedState), { expirationTtl: DAILY_TTL_SECONDS });
  } catch (error) {
    console.error('處理 PTT Lifeismoney 發生錯誤:', error);
  }
}

async function fetchAllTodayEntries(dateKey) {
  const allEntries = [];
  let url = LIFEISMONEY_URL;
  let page = 0;
  const MAX_PAGES = 10;

  while (url && page < MAX_PAGES) {
    page += 1;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CF-Worker-Lifeismoney/1.0)',
        'Accept-Language': 'zh-TW,zh;q=0.9'
      }
    });

    if (!response.ok) {
      console.error(`抓取 PTT Lifeismoney 失敗 (${url}): HTTP ${response.status}`);
      break;
    }

    const cloned = response.clone();

    const { todayEntries, hasToday, hasOlder } = await parseLifeismoneyEntries(response, dateKey);

    console.log(`第 ${page} 頁今日文章數量: ${todayEntries.length}`);

    for (const entry of todayEntries) {
      allEntries.push(entry);
    }

    const html = await cloned.text();
    const prevHref = extractPrevPageHref(html);

    const hasTodayOnly = hasToday && !hasOlder;

    // 若本頁不再是「全部都是今日」,或沒有上頁連結,就停止往前爬
    if (!hasTodayOnly || !prevHref) {
      break;
    }

    url = LIFEISMONEY_BASE_URL + prevHref;
  }

  return allEntries;
}

async function parseLifeismoneyEntries(response, dateKey) {
  const entries = [];

  const [, monthStr, dayStr] = dateKey.split('-');
  const todayMonth = parseInt(monthStr, 10);
  const todayDay = parseInt(dayStr, 10);

  // 透過 HTMLRewriter 解析 PTT HTML,官方建議的方式:
  // 參考: Cloudflare Workers HTMLRewriter docs / 將頁面轉成 JSON API 範例
  // https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/
  // https://www.mikestreety.co.uk/blog/turn-any-page-into-a-json-api-with-cloudflare-workers/

  let currentIndex = -1;

  const rewritten = new HTMLRewriter()
    .on('div.r-ent', {
      element() {
        currentIndex += 1;
        entries[currentIndex] = {
          rawPush: '',
          rawTitle: '',
          rawAuthor: '',
          rawDate: '',
          relativeUrl: ''
        };
      }
    })
    .on('div.r-ent > div.nrec', {
      text(text) {
        if (currentIndex < 0 || !entries[currentIndex]) return;
        entries[currentIndex].rawPush += text.text;
      }
    })
    .on('div.r-ent > div.title > a', {
      element(element) {
        if (currentIndex < 0 || !entries[currentIndex]) return;
        const href = element.getAttribute('href') || '';
        entries[currentIndex].relativeUrl = href;
      },
      text(text) {
        if (currentIndex < 0 || !entries[currentIndex]) return;
        entries[currentIndex].rawTitle += text.text;
      }
    })
    .on('div.r-ent > div.meta > div.author', {
      text(text) {
        if (currentIndex < 0 || !entries[currentIndex]) return;
        entries[currentIndex].rawAuthor += text.text;
      }
    })
    .on('div.r-ent > div.meta > div.date', {
      text(text) {
        if (currentIndex < 0 || !entries[currentIndex]) return;
        entries[currentIndex].rawDate += text.text;
      }
    })
    .transform(response);

  // 讀取一次 body 以觸發 HTMLRewriter 並執行上面的 handlers
  await rewritten.text();

  const todayEntries = [];
  let hasToday = false;
  let hasOlder = false;

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    const relativeUrl = (entry.relativeUrl || '').trim();
    const title = decodeHtmlEntities(cleanText(entry.rawTitle));
    const author = cleanText(entry.rawAuthor);
    const rawDate = cleanText(entry.rawDate);
    const rawPush = cleanText(entry.rawPush);

    if (!relativeUrl || !title) {
      // 沒有連結或標題,通常是刪除文章
      continue;
    }

    const isToday = isTodayTaipei(rawDate, todayMonth, todayDay);

    if (isToday) {
      hasToday = true;
    } else if (rawDate) {
      hasOlder = true;
    }

    if (!isToday) {
      continue;
    }

    const id = extractArticleId(relativeUrl);
    if (!id) {
      continue;
    }

    const pushCount = parsePushCountText(rawPush);

    todayEntries.push({
      id,
      url: LIFEISMONEY_BASE_URL + relativeUrl,
      title,
      author,
      push: pushCount
    });
  }

  return { todayEntries, hasToday, hasOlder };
}

function parsePushCountText(raw) {
  if (!raw) {
    return 0;
  }

  const valueText = raw.trim();

  if (!valueText) {
    return 0;
  }

  if (valueText === '爆') {
    return 100;
  }

  if (valueText.startsWith('X')) {
    return 0;
  }

  const value = parseInt(valueText, 10);
  return Number.isNaN(value) ? 0 : value;
}

function extractPrevPageHref(html) {
  if (!html) {
    return null;
  }

  // 優先尋找文字含「上頁」的按鈕
  const specificMatch = /<a[^>]*class="btn\s+wide"[^>]*href="([^"]+)"[^>]*>[^<]*上頁[^<]*<\/a>/i.exec(html);
  if (specificMatch && specificMatch[1]) {
    return specificMatch[1];
  }

  return null;
}

function extractArticleId(relativeUrl) {
  if (!relativeUrl) {
    return null;
  }

  const match = /\/bbs\/Lifeismoney\/([^/.]+\.A\.[^/.]+)\.html/.exec(relativeUrl);
  if (match && match[1]) {
    return match[1];
  }

  const simpleMatch = /\/bbs\/Lifeismoney\/([^/]+)\.html/.exec(relativeUrl);
  return simpleMatch && simpleMatch[1] ? simpleMatch[1] : null;
}

function isTodayTaipei(rawDate, todayMonth, todayDay) {
  if (!rawDate) {
    return false;
  }

  const m = parseInt(rawDate.split('/')[0], 10);
  const d = parseInt(rawDate.split('/')[1], 10);

  if (!Number.isFinite(m) || !Number.isFinite(d)) {
    return false;
  }

  return m === todayMonth && d === todayDay;
}

function cleanHtmlInline(html) {
  if (!html) {
    return '';
  }
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function cleanText(text) {
  if (!text) {
    return '';
  }
  return text.replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(text) {
  if (!text) {
    return '';
  }
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, '\'')
    .replace(/&hellip;/g, '…');
}

async function loadDailyState(kv, dateKey) {
  const key = buildDailyKey(dateKey);

  try {
    const raw = await kv.get(key);
    if (!raw) {
      return {
        key,
        state: {
          sourceName: 'PTT Lifeismoney 省錢板',
          sourceId: LIFEISMONEY_SOURCE_ID,
          board: 'Lifeismoney',
          dateKey,
          timezone: 'Asia/Taipei',
          items: {},
          updatedAt: null
        }
      };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid daily state JSON');
    }

    if (!parsed.items || typeof parsed.items !== 'object') {
      parsed.items = {};
    }

    return { key, state: parsed };
  } catch (error) {
    console.error('讀取每日 KV 狀態失敗,使用空集合:', error);
    return {
      key,
      state: {
        sourceName: 'PTT Lifeismoney 省錢板',
        sourceId: LIFEISMONEY_SOURCE_ID,
        board: 'Lifeismoney',
        dateKey,
        timezone: 'Asia/Taipei',
        items: {},
        updatedAt: null
      }
    };
  }
}

function mergeState(state, entries) {
  const items = state.items || {};

  for (const entry of entries) {
    const existing = items[entry.id] || {};
    items[entry.id] = {
      id: entry.id,
      url: entry.url,
      title: entry.title,
      author: entry.author,
      push: entry.push,
      sent: existing.sent === true,
      sentAt: existing.sentAt || null
    };
  }

  return {
    ...state,
    items
  };
}

function selectArticlesToSend(state, testMode) {
  const items = state.items || {};
  const candidates = [];

  for (const id of Object.keys(items)) {
    const item = items[id];
    if (!item) {
      continue;
    }
    if (item.sent) {
      continue;
    }
    if (!Number.isFinite(item.push) || item.push < PUSH_THRESHOLD) {
      continue;
    }
    candidates.push(item);
  }

  candidates.sort((a, b) => {
    if (a.push !== b.push) {
      return b.push - a.push;
    }
    return a.id.localeCompare(b.id);
  });

  if (testMode && candidates.length > 0) {
    return [candidates[0]];
  }

  return candidates;
}

async function sendToDiscord(webhookUrl, article) {
const embed = {
  title: `${article.title}`,
  url: article.url,
  author: {
    name: `${article.author}`,
    url: `https://www.ptt.cc/bbs/Lifeismoney/search?q=author%3A${article.author}`,
  },
  description: null, 
  color: 0x0066CC,
  timestamp: new Date().toISOString(),
  footer: {
    text: `PTT 省錢板 • 📈 推文數 ${article.push}`
  }
};

  const payload = { embeds: [embed] };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Discord webhook 發送失敗: ${response.status} - ${text}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error('發送 Discord webhook 發生錯誤:', error);
    return false;
  }
}

function getTaipeiDateKey(date) {
  const timestamp = date.getTime();
  const taipeiTime = new Date(timestamp + TAIPEI_OFFSET_MS);
  const year = taipeiTime.getUTCFullYear();
  const month = String(taipeiTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(taipeiTime.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDailyKey(dateKey) {
  return `daily:${encodeURIComponent(LIFEISMONEY_SOURCE_ID)}:${dateKey}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
