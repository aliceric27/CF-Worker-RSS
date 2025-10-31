// =================================================================
// Plurk Hot Topics Bot - Optimized for Cloudflare Workers Dashboard
// =================================================================
// 
// 部署說明：
// 1. 在 Cloudflare Dashboard 建立 Worker
// 2. 設定環境變數：
//    - DISCORD_WEBHOOK_URL (必須)
// 3. 綁定 KV Namespace：
//    - Variable name: PLURK_DATA
// 4. 設定 Cron Trigger：
//    - Schedule: 0 * * * * (每小時執行)
// 5. 測試端點：
//    - GET /health - 健康檢查
//    - GET /status - 查看最近資料狀態
//    - GET /test-fetch - 手動觸發抓取
//    - GET /test-post - 手動觸發統整發布
//
// =================================================================

// -------------------------------------------------
// 設定常數（可依需求調整）
// -------------------------------------------------
const CONFIG = {
  // API 設定
  PLURK_API_URL: "https://www.plurk.com/Stats/getAnonymousPlurks",
  PLURK_API_PARAMS: { lang: 'zh', limit: 50 },
  
  // 分析設定
  ANALYSIS_WINDOW_HOURS: 12,  // 分析過去 12 小時的資料
  TOP_N_RESULTS: 5,            // 取前 5 名熱門噗文
  
  // 熱度計算權重
  HOTNESS_WEIGHTS: {
    RESPONSE: 2,   // 回應數權重
    FAVORITE: 1,   // 收藏數權重
    REPLURKER: 1   // 轉噗數權重
  },
  
  // KV 儲存設定
  KV_TTL_SECONDS: 86400,       // 24 小時後過期
  
  // 重試設定
  RETRY_CONFIG: {
    MAX_RETRIES: 3,
    BASE_DELAY_MS: 1000,
    MAX_DELAY_MS: 10000
  },
  
  // Discord 設定
  DISCORD: {
    COLOR: 0x0099ff,
    MAX_DESCRIPTION_LENGTH: 4096,
    TITLE_MAX_LENGTH: 50
  },
  
  // 執行時間設定
  POST_HOURS: [0, 12],          // UTC 時間 00:00 和 12:00 執行統整
  POST_DELAY_MS: 120000         // 延遲 2 分鐘避免讀取不一致
};

// -------------------------------------------------
// 工具函數
// -------------------------------------------------

/**
 * 將十進位 ID 轉換為 Plurk 網址用的 36 進位 ID
 * @param {string | number | bigint} decimalId 
 * @returns {string}
 */
function toBase36(decimalId) {
  const num = Number(decimalId);
  // 優化：如果數字不超過 JavaScript 安全整數範圍，使用更快的方法
  if (num <= Number.MAX_SAFE_INTEGER) {
    return num.toString(36);
  }
  return BigInt(decimalId).toString(36);
}

/**
 * 根據給定的日期產生用於 KV 儲存的 Key（向下取整到小時）
 * @param {Date} date 
 * @returns {string}
 */
function getKVKey(date) {
  // 向下取整到最近的整點，避免時間偏移問題
  const flooredDate = new Date(date);
  flooredDate.setUTCMinutes(0, 0, 0);
  
  // 格式化為 YYYYMMDD_HH00 (UTC 時間)
  const keyTimestamp = flooredDate.toISOString()
    .slice(0, 13)
    .replace(/-/g, '')
    .replace('T', '_') + '00';
  
  return `PLURKS_${keyTimestamp}`;
}

/**
 * 清理文字內容，防止 Discord Markdown 破壞
 * @param {string} text 
 * @param {number} maxLength 
 * @returns {string}
 */
function sanitizeText(text, maxLength = CONFIG.DISCORD.TITLE_MAX_LENGTH) {
  if (!text || typeof text !== 'string') {
    return '[無內容]';
  }
  
  return text
    .replace(/[\\*_`~|]/g, '\\$&')     // 轉義 Markdown 特殊字元
    .replace(/[\[\]()]/g, '\\$&')      // 轉義連結字元
    .replace(/\n/g, ' ')                // 換行改為空格
    .substring(0, maxLength)
    .trim() || '[空白]';
}

/**
 * 結構化日誌記錄器
 */
class Logger {
  constructor(requestId, context = {}) {
    this.requestId = requestId;
    this.context = {
      worker: 'plurk-anonymous',
      version: '2.0.0',
      ...context
    };
  }
  
  _log(level, message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      requestId: this.requestId,
      message,
      ...this.context,
      ...data
    };
    console.log(JSON.stringify(entry));
  }
  
  info(message, data) { this._log('INFO', message, data); }
  warn(message, data) { this._log('WARN', message, data); }
  error(message, error, data) {
    this._log('ERROR', message, {
      ...data,
      error: error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : undefined
    });
  }
}

/**
 * 帶重試的 Fetch 請求
 * @param {string} url 
 * @param {object} options 
 * @param {number} maxRetries 
 * @param {Logger} logger 
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, maxRetries = CONFIG.RETRY_CONFIG.MAX_RETRIES, logger = null) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // 成功回應
      if (response.ok) {
        if (logger && attempt > 0) {
          logger.info('重試成功', { attempt: attempt + 1 });
        }
        return response;
      }
      
      // 5xx 錯誤才重試，4xx 直接拋出
      if (response.status < 500) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      
      lastError = new Error(`HTTP ${response.status}`);
      
    } catch (error) {
      lastError = error;
    }
    
    // 最後一次嘗試失敗，不再重試
    if (attempt === maxRetries - 1) {
      break;
    }
    
    // 指數退避延遲
    const delay = Math.min(
      CONFIG.RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt),
      CONFIG.RETRY_CONFIG.MAX_DELAY_MS
    );
    
    if (logger) {
      logger.warn('請求失敗，準備重試', {
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        error: lastError.message
      });
    }
    
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  throw lastError;
}

/**
 * 驗證環境變數設定
 * @param {object} env 
 * @throws {Error}
 */
function validateEnvironment(env) {
  const errors = [];
  
  if (!env.PLURK_DATA) {
    errors.push('❌ KV Namespace "PLURK_DATA" 未綁定');
  }
  
  if (!env.DISCORD_WEBHOOK_URL) {
    errors.push('❌ 環境變數 "DISCORD_WEBHOOK_URL" 未設定');
  } else if (!env.DISCORD_WEBHOOK_URL.startsWith('https://discord.com/api/webhooks/')) {
    errors.push('❌ DISCORD_WEBHOOK_URL 格式不正確（應以 https://discord.com/api/webhooks/ 開頭）');
  }
  
  if (errors.length > 0) {
    throw new Error(`環境設定錯誤:\n${errors.join('\n')}`);
  }
}


// -------------------------------------------------
// 任務 A: 每小時執行，抓取並儲存資料
// -------------------------------------------------
async function fetchAndStore(env, logger) {
  const apiUrl = new URL(CONFIG.PLURK_API_URL);
  Object.entries(CONFIG.PLURK_API_PARAMS).forEach(([key, value]) => {
    apiUrl.searchParams.set(key, value);
  });
  
  logger.info('開始執行每小時抓取任務', { apiUrl: apiUrl.toString() });
  const startTime = Date.now();

  try {
    // 使用重試機制抓取 API
    const response = await fetchWithRetry(apiUrl.toString(), {}, CONFIG.RETRY_CONFIG.MAX_RETRIES, logger);
    const data = await response.json();
    
    // 過濾有效的噗文資料
    const plurksArray = Object.values(data).filter(item => 
      typeof item === 'object' && 
      item !== null && 
      item.plurk_id
    );

    if (plurksArray.length === 0) {
      logger.warn('API 回應無有效噗文資料');
      return;
    }

    const now = new Date();
    const key = getKVKey(now);
    const dataString = JSON.stringify(plurksArray);
    
    // 檢查資料大小
    const sizeKB = new Blob([dataString]).size / 1024;
    if (sizeKB > 1024) {
      logger.warn('資料量較大', { sizeKB: sizeKB.toFixed(2) });
    }
    
    // 將資料存入 KV，並設定過期時間
    await env.PLURK_DATA.put(key, dataString, {
      expirationTtl: CONFIG.KV_TTL_SECONDS,
      metadata: {
        fetchedAt: now.toISOString(),
        count: plurksArray.length,
        sizeKB: Math.round(sizeKB)
      }
    });
    
    const duration = Date.now() - startTime;
    logger.info('抓取任務完成', {
      key,
      plurkCount: plurksArray.length,
      sizeKB: sizeKB.toFixed(2),
      durationMs: duration
    });
    
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('抓取任務失敗', error, { durationMs: duration });
    throw error; // 重新拋出以便外層處理
  }
}

// -------------------------------------------------
// 任務 B: 每 12 小時執行，處理並發布
// -------------------------------------------------
async function processAndPost(env, logger) {
  logger.info('開始執行 12 小時統整任務');
  const startTime = Date.now();
  
  try {
    const now = new Date();
    const keyPromises = [];
    const requestedKeys = [];

    // 產生過去 N 小時的 KV Keys（從 1 開始，避免讀取當前正在寫入的資料）
    for (let i = 1; i <= CONFIG.ANALYSIS_WINDOW_HOURS; i++) {
      const pastDate = new Date(now.getTime() - i * 60 * 60 * 1000);
      const key = getKVKey(pastDate);
      requestedKeys.push({ key, hoursAgo: i });
      keyPromises.push(
        env.PLURK_DATA.getWithMetadata(key)
          .then(result => ({ key, hoursAgo: i, data: result }))
      );
    }

    // 並行讀取所有資料
    const results = await Promise.all(keyPromises);
    
    // 檢測缺失的資料
    const missingHours = [];
    const validResults = [];
    
    for (const result of results) {
      if (!result.data.value) {
        missingHours.push(result.hoursAgo);
        logger.warn('資料缺失', { key: result.key, hoursAgo: result.hoursAgo });
      } else {
        validResults.push(result);
      }
    }
    
    // 如果缺失超過 1/3 的資料，發送警告但繼續處理
    if (missingHours.length > CONFIG.ANALYSIS_WINDOW_HOURS / 3) {
      logger.error('資料缺失嚴重', new Error('Data Incomplete'), {
        missingCount: missingHours.length,
        totalHours: CONFIG.ANALYSIS_WINDOW_HOURS,
        missingHours
      });
      
      // 發送警告到 Discord
      await sendDiscordAlert(env, logger, 
        `⚠️ **資料完整性警告**\n` +
        `過去 ${CONFIG.ANALYSIS_WINDOW_HOURS} 小時內有 ${missingHours.length} 小時的資料缺失\n` +
        `缺失時段: ${missingHours.map(h => `${h}h前`).join(', ')}`
      );
    }
    
    if (validResults.length === 0) {
      logger.warn('沒有任何可用資料');
      return;
    }
    
    // 🚀 優化：使用 Min-Heap 找 Top K，避免完整排序
    const top5Plurks = findTopKPlurks(validResults, CONFIG.TOP_N_RESULTS, logger);
    
    if (top5Plurks.length === 0) {
      logger.info('沒有找到值得發布的熱門話題');
      return;
    }
    
    // 建立 Discord Embed
    const embedDescription = buildEmbedDescription(top5Plurks);
    
    // 檢查長度限制
    if (embedDescription.length > CONFIG.DISCORD.MAX_DESCRIPTION_LENGTH) {
      logger.warn('Discord Embed 內容過長', {
        length: embedDescription.length,
        max: CONFIG.DISCORD.MAX_DESCRIPTION_LENGTH
      });
      throw new Error('Embed 內容超過 Discord 限制');
    }
    
    const discordPayload = {
      content: `📢 **過去 ${CONFIG.ANALYSIS_WINDOW_HOURS} 小時，偷偷說總熱門話題 Top ${top5Plurks.length}！**`,
      embeds: [{
        title: "熱門話題排行榜",
        description: embedDescription,
        color: CONFIG.DISCORD.COLOR,
        timestamp: new Date().toISOString(),
        footer: {
          text: `分析了 ${validResults.length}/${CONFIG.ANALYSIS_WINDOW_HOURS} 小時的資料`
        }
      }],
    };
    
    // 發送到 Discord
    const webhookResponse = await fetchWithRetry(
      env.DISCORD_WEBHOOK_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayload),
      },
      CONFIG.RETRY_CONFIG.MAX_RETRIES,
      logger
    );
    
    if (!webhookResponse.ok) {
      const errorText = await webhookResponse.text();
      throw new Error(`Discord Webhook 失敗: ${webhookResponse.status} - ${errorText}`);
    }

    const duration = Date.now() - startTime;
    logger.info('統整任務完成', {
      topPlurksCount: top5Plurks.length,
      dataHours: validResults.length,
      missingHours: missingHours.length,
      durationMs: duration
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('統整任務失敗', error, { durationMs: duration });
    throw error;
  }
}

/**
 * 🚀 使用 Min-Heap 算法找出 Top K 噗文（優化 CPU 時間）
 * 時間複雜度：O(n log k) 而非 O(n log n)
 */
function findTopKPlurks(validResults, k, logger) {
  const heap = [];
  let totalProcessed = 0;
  
  for (const result of validResults) {
    try {
      const hourlyPlurks = JSON.parse(result.data.value);
      
      if (!Array.isArray(hourlyPlurks)) {
        logger.warn('KV 資料格式錯誤', { key: result.key });
        continue;
      }
      
      for (const plurk of hourlyPlurks) {
        totalProcessed++;
        
        // 驗證必要欄位
        if (!plurk.plurk_id || typeof plurk.plurk_id !== 'number') {
          continue;
        }
        
        // 計算熱度分數
        const score = (
          (plurk.response_count || 0) * CONFIG.HOTNESS_WEIGHTS.RESPONSE +
          (plurk.favorite_count || 0) * CONFIG.HOTNESS_WEIGHTS.FAVORITE +
          (plurk.replurkers_count || 0) * CONFIG.HOTNESS_WEIGHTS.REPLURKER
        );
        
        if (score === 0) continue;
        
        // 維護大小為 k 的最小堆
        if (heap.length < k) {
          heap.push({ plurk, score });
          if (heap.length === k) {
            heap.sort((a, b) => a.score - b.score);
          }
        } else if (score > heap[0].score) {
          // 替換堆頂（最小值）
          heap[0] = { plurk, score };
          
          // 向下調整堆（維持最小堆性質）
          let i = 0;
          while (i * 2 + 1 < k) {
            const left = i * 2 + 1;
            const right = i * 2 + 2;
            let smallest = i;
            
            if (left < k && heap[left].score < heap[smallest].score) {
              smallest = left;
            }
            if (right < k && heap[right].score < heap[smallest].score) {
              smallest = right;
            }
            
            if (smallest === i) break;
            
            [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
            i = smallest;
          }
        }
      }
    } catch (error) {
      logger.warn('解析資料失敗', { key: result.key, error: error.message });
    }
  }
  
  logger.info('分析完成', {
    totalProcessed,
    topKFound: heap.length
  });
  
  // 最終排序（只有 k 個元素）
  return heap
    .sort((a, b) => b.score - a.score)
    .map(item => ({
      plurk_id: item.plurk.plurk_id,
      content_raw: item.plurk.content_raw,
      response_count: item.plurk.response_count || 0,
      favorite_count: item.plurk.favorite_count || 0,
      replurkers_count: item.plurk.replurkers_count || 0,
      hotness_score: item.score
    }));
}

/**
 * 建立 Discord Embed 描述文字
 */
function buildEmbedDescription(plurks) {
  return plurks.map((plurk, index) => {
    const url = `https://www.plurk.com/p/${toBase36(plurk.plurk_id)}`;
    const title = sanitizeText(plurk.content_raw, CONFIG.DISCORD.TITLE_MAX_LENGTH);
    
    return (
      `**${index + 1}. [${title}...](${url})**\n` +
      `> 💬 ${plurk.response_count} • ❤️ ${plurk.favorite_count} • 🔄 ${plurk.replurkers_count} • 🔥 ${plurk.hotness_score}`
    );
  }).join('\n\n');
}

/**
 * 發送警告訊息到 Discord
 */
async function sendDiscordAlert(env, logger, message) {
  try {
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: message,
        username: 'Plurk Bot Alert'
      })
    });
  } catch (error) {
    logger.error('發送警告失敗', error);
  }
}


// -------------------------------------------------
// Worker 主進入點
// -------------------------------------------------
export default {
  // 定時觸發的進入點（由 Cron Trigger 觸發）
  async scheduled(event, env, ctx) {
    const requestId = crypto.randomUUID();
    const logger = new Logger(requestId, { trigger: 'cron' });
    
    try {
      // 驗證環境設定
      validateEnvironment(env);
      
      const now = new Date();
      const hour = now.getUTCHours();
      
      logger.info('Cron 觸發', {
        utcTime: now.toISOString(),
        hour,
        willPost: CONFIG.POST_HOURS.includes(hour)
      });
      
      // 每小時都執行抓取任務
      ctx.waitUntil(
        fetchAndStore(env, logger).catch(error => {
          logger.error('抓取任務異常', error);
        })
      );
      
      // 只在設定的時間執行統整任務
      if (CONFIG.POST_HOURS.includes(hour)) {
        // 延遲執行，確保 KV 寫入完成
        ctx.waitUntil(
          new Promise(resolve => setTimeout(resolve, CONFIG.POST_DELAY_MS))
            .then(() => processAndPost(env, logger))
            .catch(error => {
              logger.error('統整任務異常', error);
            })
        );
      }
      
    } catch (error) {
      logger.error('Scheduled 處理失敗', error);
    }
  },

  // HTTP 請求進入點（測試和健康檢查）
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();
    const logger = new Logger(requestId, { trigger: 'http' });
    
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // 健康檢查端點
      if (path === '/health') {
        try {
          validateEnvironment(env);
          
          // 測試 KV 連線
          const testKey = `health_check_${Date.now()}`;
          await env.PLURK_DATA.put(testKey, 'ok', { expirationTtl: 60 });
          const testValue = await env.PLURK_DATA.get(testKey);
          
          return new Response(JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            requestId,
            checks: {
              kv: testValue === 'ok' ? 'pass' : 'fail',
              discord: env.DISCORD_WEBHOOK_URL ? 'configured' : 'missing'
            },
            config: {
              analysisWindowHours: CONFIG.ANALYSIS_WINDOW_HOURS,
              topNResults: CONFIG.TOP_N_RESULTS,
              postHours: CONFIG.POST_HOURS
            }
          }, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          logger.error('健康檢查失敗', error);
          return new Response(JSON.stringify({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
          }, null, 2), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // 狀態查詢端點
      if (path === '/status') {
        try {
          validateEnvironment(env);
          
          const now = new Date();
          const recentData = [];
          
          // 檢查最近 3 小時的資料
          for (let i = 0; i < 3; i++) {
            const pastDate = new Date(now.getTime() - i * 60 * 60 * 1000);
            const key = getKVKey(pastDate);
            const result = await env.PLURK_DATA.getWithMetadata(key);
            
            recentData.push({
              key,
              hoursAgo: i,
              exists: !!result.value,
              metadata: result.metadata,
              utcHour: pastDate.getUTCHours()
            });
          }
          
          return new Response(JSON.stringify({
            timestamp: new Date().toISOString(),
            requestId,
            utcHour: now.getUTCHours(),
            nextPostHour: CONFIG.POST_HOURS.find(h => h > now.getUTCHours()) || CONFIG.POST_HOURS[0],
            recentData
          }, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          logger.error('狀態查詢失敗', error);
          return new Response(JSON.stringify({
            error: error.message
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }
      
      // 手動觸發抓取
      if (path === '/test-fetch') {
        try {
          validateEnvironment(env);
          logger.info('手動觸發抓取任務');
          await fetchAndStore(env, logger);
          return new Response('✅ 手動觸發抓取任務完成\n查看日誌以了解詳細資訊', {
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        } catch (error) {
          logger.error('手動抓取失敗', error);
          return new Response(`❌ 抓取失敗: ${error.message}`, {
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      }
      
      // 手動觸發統整
      if (path === '/test-post') {
        try {
          validateEnvironment(env);
          logger.info('手動觸發統整任務');
          await processAndPost(env, logger);
          return new Response('✅ 手動觸發統整任務完成\n查看日誌以了解詳細資訊', {
            status: 200,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        } catch (error) {
          logger.error('手動統整失敗', error);
          return new Response(`❌ 統整失敗: ${error.message}`, {
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      }
      
      // 預設回應（使用說明）
      return new Response(`
╔══════════════════════════════════════════════════════════╗
║   Plurk Hot Topics Bot - Cloudflare Worker v2.0         ║
╚══════════════════════════════════════════════════════════╝

這是一個由排程驅動的 Worker，每小時自動執行。

📋 可用端點：

  GET /health
    ➜ 健康檢查，測試 KV 和環境設定

  GET /status
    ➜ 查看最近 3 小時的資料狀態

  GET /test-fetch
    ➜ 手動觸發抓取任務（測試用）

  GET /test-post
    ➜ 手動觸發統整發布任務（測試用）

⚙️  當前設定：
  • 分析時間窗口: ${CONFIG.ANALYSIS_WINDOW_HOURS} 小時
  • 熱門排名數量: Top ${CONFIG.TOP_N_RESULTS}
  • 發布時間: UTC ${CONFIG.POST_HOURS.join(', ')} 點

📊 執行狀態：
  • 當前 UTC 時間: ${new Date().toISOString()}
  • 當前 UTC 小時: ${new Date().getUTCHours()}
  • Request ID: ${requestId}

🔧 設定檢查：
  • KV Namespace: ${env.PLURK_DATA ? '✅ 已綁定' : '❌ 未綁定'}
  • Discord Webhook: ${env.DISCORD_WEBHOOK_URL ? '✅ 已設定' : '❌ 未設定'}

📚 文件：https://github.com/aliceric27/CF-Worker-RSS
      `.trim(), {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
      
    } catch (error) {
      logger.error('HTTP 請求處理失敗', error);
      return new Response(`Internal Server Error: ${error.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
};