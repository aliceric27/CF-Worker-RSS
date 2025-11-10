export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname === '/trigger') {
      await processForum(env, true);
      return new Response('Processing triggered', { status: 200 });
    }
    
    if (url.pathname === '/clearkv') {
      const kv = env.RSS_CACHE;
      await kv.delete('sent:bahamut-forum');
      return new Response('KV cache cleared', { status: 200 });
    }
    
    return new Response('Worker running', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processForum(env, false));
  }
};

async function processForum(env, testMode = false) {
  const kv = env.RSS_CACHE;
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  const forumUrl = 'https://forum.gamer.com.tw/B.php?bsn=17608&subbsn=23';
  const now = new Date();

  try {
    const sentKey = `sent:bahamut-forum`;
    const lastRunKey = `lastrun:bahamut-forum`;

    // 檢查上次執行時間 (除非是測試模式)
    if (!testMode) {
      const lastRunData = await kv.get(lastRunKey);
      if (lastRunData) {
        const lastRunTime = new Date(lastRunData);
        const hoursSinceLastRun = (now - lastRunTime) / (1000 * 60 * 60);
        
        if (hoursSinceLastRun < 24) {
          console.log(`距離上次執行僅 ${hoursSinceLastRun.toFixed(1)} 小時，跳過此次執行`);
          return;
        }
      }
    }

    // 獲取已發送記錄
    const sentData = await kv.get(sentKey);
    const sentMap = sentData ? new Map(Object.entries(JSON.parse(sentData))) : new Map();

    // 抓取最新文章
    const response = await fetch(forumUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const articles = parseArticles(html);

    console.log(`抓取到 ${articles.length} 篇文章`);

    // 過濾出未發送的文章
    const unsent = articles.filter(a => !sentMap.has(hashId(a.id)));
    
    console.log(`未發送文章: ${unsent.length} 篇`);

    if (unsent.length === 0) {
      console.log('沒有新文章需要發送');
      return;
    }

    // 找出人氣最高的文章
    const topArticle = unsent.reduce((max, article) => 
      article.popularity > max.popularity ? article : max
    );

    console.log(`人氣最高文章: ${topArticle.title} (人氣: ${topArticle.popularity})`);

    // 發送到 Discord
    const sent = await sendDiscordSingle(webhookUrl, topArticle, now);
    
    if (sent) {
      // 標記為已發送
      sentMap.set(hashId(topArticle.id), { 
        sentAt: now.toISOString(), 
        id: topArticle.id,
        popularity: topArticle.popularity
      });
      
      // 更新 KV
      await kv.put(sentKey, JSON.stringify(Object.fromEntries(sentMap)), { expirationTtl: 604800 });
      
      // 記錄執行時間
      await kv.put(lastRunKey, now.toISOString(), { expirationTtl: 604800 });
      
      console.log('文章已成功發送並記錄');
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

function parseArticles(html) {
  const articles = [];
  const regex = /<tr class="b-list__row[^"]*">[\s\S]*?<td class="b-list__main">([\s\S]*?)<\/td>[\s\S]*?<td class="b-list__count">([\s\S]*?)<\/td>[\s\S]*?<td class="b-list__time">([\s\S]*?)<\/td>/g;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const mainContent = match[1];
    const countContent = match[2];
    const timeContent = match[3];

    const linkMatch = /href="(C\.php\?[^"]+)"/.exec(mainContent);
    const titleMatch = /<p[^>]*class="b-list__main__title"[^>]*>([^<]+)<\/p>/.exec(mainContent);
    const briefMatch = /<p class="b-list__brief">([^<]+)<\/p>/.exec(mainContent);
    const thumbMatch = /data-thumbnail="([^"]+)"/.exec(mainContent);
    
    // 解析最後回覆時間
    const lastReplyMatch = /<p class="b-list__time__edittime">[\s\S]*?>([^<]+)<\/a>/.exec(timeContent);
    const lastReplyTime = lastReplyMatch ? lastReplyMatch[1].trim() : null;
    
    // 檢查是否超過一周
    if (!isWithinOneWeek(lastReplyTime)) {
      continue; // 跳過超過一周的文章
    }

    // 解析統計數據
    const stats = parseStats(countContent);

    if (linkMatch && titleMatch) {
      const relativeUrl = linkMatch[1];
      const snAMatch = /snA=(\d+)/.exec(relativeUrl);
      const id = snAMatch ? snAMatch[1] : null;

      if (id) {
        articles.push({
          id,
          title: titleMatch[1].trim(),
          brief: briefMatch ? briefMatch[1].replace(/&hellip;/g, '...').replace(/&nbsp;/g, ' ').trim() : '',
          link: `https://forum.gamer.com.tw/${relativeUrl}`,
          thumbnail: thumbMatch ? thumbMatch[1] : null,
          lastReplyTime: lastReplyTime,
          ...stats
        });
      }
    }
  }

  return articles;
}

function isWithinOneWeek(timeStr) {
  if (!timeStr) return false;
  
  const now = new Date();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000; // 一周的毫秒數
  
  // 解析各種時間格式
  // 格式: "6 小時前", "2 天前", "1 週前", "12-25 10:30" 等
  
  // 處理相對時間
  if (timeStr.includes('分鐘前') || timeStr.includes('小時前')) {
    return true; // 幾分鐘或幾小時前肯定在一周內
  }
  
  if (timeStr.includes('天前')) {
    const days = parseInt(timeStr.match(/(\d+)\s*天前/)[1]);
    return days < 7;
  }
  
  if (timeStr.includes('週前') || timeStr.includes('周前')) {
    const weeks = parseInt(timeStr.match(/(\d+)\s*[週周]前/)[1]);
    return weeks < 1;
  }
  
  if (timeStr.includes('月前') || timeStr.includes('年前')) {
    return false; // 超過一個月或一年,肯定超過一周
  }
  
  // 處理絕對時間格式 (MM-DD HH:mm)
  const dateMatch = timeStr.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (dateMatch) {
    const [, month, day, hour, minute] = dateMatch;
    const articleDate = new Date(now.getFullYear(), parseInt(month) - 1, parseInt(day), parseInt(hour), parseInt(minute));
    
    // 如果日期在未來,表示是去年的日期
    if (articleDate > now) {
      articleDate.setFullYear(now.getFullYear() - 1);
    }
    
    const diffMs = now - articleDate;
    return diffMs < oneWeekMs;
  }
  
  // 無法解析,保守起見認為在一周內
  console.log('無法解析時間格式:', timeStr);
  return true;
}

function parseStats(countContent) {
  const stats = { interaction: 0, popularity: 0 };
  
  // 解析互動數和人氣數
  // 格式: <span title="互動：101">101</span>/<span title="人氣：10,787">10k</span>
  const interactionMatch = /<span title="互動：([0-9,]+)">/.exec(countContent);
  const popularityMatch = /<span title="人氣：([0-9,]+)">/.exec(countContent);
  
  if (interactionMatch) {
    stats.interaction = parseInt(interactionMatch[1].replace(/,/g, ''), 10);
  }
  
  if (popularityMatch) {
    stats.popularity = parseInt(popularityMatch[1].replace(/,/g, ''), 10);
  }
  
  // DEBUG: 記錄解析結果
  console.log('Parsed stats:', { interaction: stats.interaction, popularity: stats.popularity });
  
  return stats;
}



function hashId(id) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, '0');
}

async function sendDiscordSingle(webhookUrl, article, timestamp) {
  const embed = {
    title: article.title,
    description: article.brief || '無簡介',
    url: article.link,
    color: 0x009CAD,
    timestamp: timestamp.toISOString(),
    fields: [
      {
        name: '',
        value: `💬 互動：${article.interaction.toLocaleString()} 🔥 人氣：${article.popularity.toLocaleString()}`,
        inline: true
      },
      {
        name: '',
        value: `\n`,
        inline: true
      }
    ],
    footer: { 
      text: `巴哈姆特 FFXIV 板` 
    }
  };

  // 添加縮圖
  if (article.thumbnail) {
    embed.image = { url: article.thumbnail };
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  });

  if (!response.ok) {
    console.error(`Discord failed: ${response.status}`);
    const errorText = await response.text();
    console.error('Discord error response:', errorText);
  }

  return response.ok;
}


