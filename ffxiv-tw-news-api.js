// 分類映射：英文參數 → 中文分類名稱
const CATEGORY_MAP = {
  'event': '活動',
  'other': '其他',
  'maintain': '維護',
  'update': '更新'
};

export default {
  async scheduled(event, env, ctx) {
    await fetchAndStoreNews(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const categoryParam = url.searchParams.get("category");

    // 手動強制更新: /?update=true
    if (url.searchParams.get("update") === "true") {
      const result = await fetchAndStoreNews(env);

      // 如果同時帶有 category 參數，先更新再篩選
      if (categoryParam) {
        const filtered = filterByCategory(result, categoryParam);
        return new Response(JSON.stringify(filtered, null, 2), {
          headers: { "Content-Type": "application/json;charset=UTF-8" }
        });
      }

      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json;charset=UTF-8" }
      });
    }

    // 讀取 KV 資料
    const rawData = await env.ffxivnewsKV.get("ffxiv_news_v3");

    if (!rawData) {
      return new Response(JSON.stringify({
        error: "No data found",
        tip: "Try visiting /?update=true to trigger the first fetch."
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 如果有 category 參數，篩選資料
    if (categoryParam) {
      const data = JSON.parse(rawData);
      const filtered = filterByCategory(data, categoryParam);
      return new Response(JSON.stringify(filtered, null, 2), {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // 無參數：返回原始完整資料
    return new Response(rawData, {
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }
};

async function fetchAndStoreNews(env) {
  const pagesToFetch = [1, 2, 3];
  const baseUrl = "https://www.ffxiv.com.tw/web/news/news_list.aspx?page=";
  
  // 關鍵修正：加入 User-Agent 偽裝成瀏覽器
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Referer": "https://www.ffxiv.com.tw/"
  };

  console.log("Starting fetch...");

  const promises = pagesToFetch.map(page => 
    fetch(baseUrl + page, { headers }).then(async res => {
        if (!res.ok) {
            console.error(`Page ${page} failed: ${res.status}`);
            return [];
        }
        return parseHtml(res);
    })
  );

  const results = await Promise.all(promises);
  const flatList = results.flat();

  console.log(`Total items fetched (raw): ${flatList.length}`);

  if (flatList.length === 0) {
    return { error: "Fetched 0 items. The site layout might have changed or blocked the request." };
  }

  const processedData = processData(flatList);
  
  // 存入 KV (Key 更新為 v3)
  await env.ffxivnewsKV.put("ffxiv_news_v3", JSON.stringify(processedData));
  
  return processedData;
}

async function parseHtml(response) {
  const newsItems = [];
  let currentItem = null;

  const rewriter = new HTMLRewriter()
    // 1. 監聽每個新聞項目容器
    .on("div.item", {
      element(el) {
        // 初始化新的新聞項目
        currentItem = {
          id: "",
          category: "",
          title: "",
          url: "",
          date: "",
          views: "",
          isTop: false
        };
        newsItems.push(currentItem);
      }
    })

    // 2. 提取編號
    .on("div.news_id", {
      text(chunk) {
        if (currentItem) {
          currentItem.id += chunk.text.trim();
        }
      }
    })

    // 3. 提取分類 (從 class 判斷)
    .on("div.type", {
      element(el) {
        if (!currentItem) return;

        // 檢查 class 屬性 (例如: "type event", "type other", "type maintain", "type update")
        const classNames = el.getAttribute("class") || "";

        if (classNames.includes("event")) {
          currentItem.category = "活動";
        } else if (classNames.includes("maintain")) {
          currentItem.category = "維護";
        } else if (classNames.includes("update")) {
          currentItem.category = "更新";
        } else if (classNames.includes("other")) {
          currentItem.category = "其他";
        } else {
          currentItem.category = "其他"; // 預設
        }
      }
    })

    // 4. 檢查是否置頂
    .on("span.badge.top", {
      element(el) {
        if (currentItem) {
          currentItem.isTop = true;
        }
      }
    })

    // 5. 提取標題與連結
    .on("div.title a", {
      element(el) {
        if (currentItem) {
          const href = el.getAttribute("href");
          if (href) {
            // 處理相對/絕對路徑
            if (href.startsWith("http")) {
              currentItem.url = href;
            } else if (href.startsWith("/")) {
              currentItem.url = `https://www.ffxiv.com.tw${href}`;
            } else {
              currentItem.url = `https://www.ffxiv.com.tw/web/news/${href}`;
            }
          }
        }
      },
      text(chunk) {
        if (currentItem) {
          currentItem.title += chunk.text.trim();
        }
      }
    })

    // 6. 提取發布日期
    .on("div.publish_date", {
      text(chunk) {
        if (currentItem) {
          currentItem.date += chunk.text.trim();
        }
      }
    })

    // 7. 提取瀏覽數
    .on("div.view_count", {
      text(chunk) {
        if (currentItem) {
          currentItem.views += chunk.text.trim();
        }
      }
    });

  await rewriter.transform(response).text();

  // 過濾無效資料
  // 條件：ID 必須能轉為數字 (過濾掉表頭 "編號") 且 標題不為空
  return newsItems.filter(item => {
    return item.id && !isNaN(parseInt(item.id)) && item.title;
  });
}

function processData(rawItems) {
  const uniqueMap = new Map();

  // 1. 去重與資料標準化
  for (const item of rawItems) {
    // 清理數據
    item.id = item.id.trim();
    item.category = item.category.trim();
    item.title = item.title.trim();
    item.date = item.date.trim();
    item.views = item.views.trim();

    // 如果分類抓不到，給個預設值
    if (!item.category) item.category = "公告";

    // 日期標準化: 2025/11/21 → 2025-11-21
    if (item.date) {
      const parts = item.date.split("/");
      if (parts.length === 3) {
        const [year, month, day] = parts;
        item.date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    }

    // 瀏覽數轉為數字 (移除千分位逗號)
    item.views = parseInt(item.views.replace(/,/g, "")) || 0;

    if (!uniqueMap.has(item.id)) {
      uniqueMap.set(item.id, item);
    }
  }

  const uniqueItems = Array.from(uniqueMap.values());

  // 2. 排序 (置頂文章優先，其次按 ID 倒序)
  let sortedTimeline = uniqueItems.sort((a, b) => {
    // 置頂文章排在最前面
    if (a.isTop && !b.isTop) return -1;
    if (!a.isTop && b.isTop) return 1;
    // 其次按 ID 倒序
    return parseInt(b.id) - parseInt(a.id);
  });

  // 3. 容量限制 (最多保留 500 筆)
  const MAX_ITEMS = 500;
  if (sortedTimeline.length > MAX_ITEMS) {
    console.log(`Limiting items from ${sortedTimeline.length} to ${MAX_ITEMS}`);
    sortedTimeline = sortedTimeline.slice(0, MAX_ITEMS);
  }

  // 4. 分類
  const grouped = {};
  for (const item of sortedTimeline) {
    if (!grouped[item.category]) {
      grouped[item.category] = [];
    }
    grouped[item.category].push(item);
  }

  return {
    meta: {
      last_updated: new Date().toISOString(),
      total_count: sortedTimeline.length,
      source: "FFXIV Taiwan Official News",
      version: "v3"
    },
    categories: grouped,
    timeline: sortedTimeline
  };
}

/**
 * 根據英文分類參數篩選資料
 * @param {Object} data - 完整的 KV 資料（已解析為 JSON）
 * @param {string} categoryParam - URL 參數值（例如 "event" 或 "event,news"）
 * @returns {Object} 篩選後的結果或錯誤訊息
 */
function filterByCategory(data, categoryParam) {
  // 解析多個分類（支援逗號分隔）
  const requestedCategories = categoryParam
    .split(',')
    .map(c => c.trim().toLowerCase())
    .filter(c => c.length > 0);

  if (requestedCategories.length === 0) {
    return {
      error: "Invalid category parameter",
      available_categories: Object.keys(CATEGORY_MAP),
      tip: "Use ?category=event or ?category=event,news"
    };
  }

  // 檢查是否所有請求的英文參數都有效
  const invalidCategories = requestedCategories.filter(
    cat => !CATEGORY_MAP[cat]
  );

  if (invalidCategories.length > 0) {
    return {
      error: "Invalid category",
      requested: invalidCategories,
      available_categories: Object.keys(CATEGORY_MAP),
      tip: `Valid categories: ${Object.keys(CATEGORY_MAP).join(', ')}`
    };
  }

  // 將英文參數轉換為中文分類名稱
  const chineseCategories = requestedCategories.map(cat => CATEGORY_MAP[cat]);

  // 篩選 timeline 中符合條件的文章
  const filteredItems = (data.timeline || []).filter(item =>
    chineseCategories.includes(item.category)
  );

  return {
    meta: {
      last_updated: data.meta.last_updated,
      total_count: filteredItems.length,
      filtered_from: data.meta.total_count,
      source: data.meta.source,
      version: data.meta.version
    },
    filter: {
      categories: requestedCategories
    },
    data: filteredItems
  };
}