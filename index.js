require("dotenv").config();
const axios = require("axios");
const { Telegraf } = require("telegraf");
const express = require("express");

// === CONFIGURATION FROM .ENV ===
const SKU_LIST = process.env.SKU_LIST
  ? process.env.SKU_LIST.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [];
const CHECK_INTERVAL_SEC = parseInt(process.env.CHECK_INTERVAL_SEC || "30", 10);
const CHECK_INTERVAL = CHECK_INTERVAL_SEC * 1000; // convert to milliseconds
const LOCALE = process.env.LOCALE || "en-us";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN) {
  console.error("Error: TELEGRAM_TOKEN not specified in .env");
  process.exit(1);
}

if (SKU_LIST.length === 0) {
  console.error("Error: SKU_LIST not specified in .env or empty");
  process.exit(1);
}

if (!CHAT_ID) {
  console.warn("Warning: CHAT_ID not specified in .env");
}

// === Telegram Bot ===
const bot = new Telegraf(TELEGRAM_TOKEN);

// Constants
const API_TIMEOUT = 30000; // 30 seconds
const API_BASE_URL = "https://api.store.nvidia.com/partner/v1/feinventory";
const HTTP_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9,ru;q=0.8",
  origin: "https://notify-fe.plen.io",
  referer: "https://notify-fe.plen.io/",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
};

// Data storage
let serverStartTime = new Date();
let lastLogs = {}; // sku → { timestamp, status, error?, price? }
let stockNotificationsEnabled = true; // toggle for stock notifications
let errorNotificationsEnabled = true; // toggle for error/SKU problem notifications

// Function to format time
const ago = (date) =>
  date ? `${Math.round((Date.now() - date) / 1000)} sec ago` : "never";

// Commands
bot.start((ctx) =>
  ctx.reply(
    "NVIDIA Founders Edition monitoring started\nCommands: /status /toggle_stock /toggle_errors"
  )
);

bot.command("toggle_stock", (ctx) => {
  stockNotificationsEnabled = !stockNotificationsEnabled;
  const status = stockNotificationsEnabled ? "enabled" : "disabled";
  ctx.reply(`Stock notifications ${status}`);
});

bot.command("toggle_errors", (ctx) => {
  errorNotificationsEnabled = !errorNotificationsEnabled;
  const status = errorNotificationsEnabled ? "enabled" : "disabled";
  ctx.reply(`Error/SKU problem notifications ${status}`);
});

bot.command("status", (ctx) => {
  const uptime = ago(serverStartTime);
  let text = `Server uptime: ${escapeMarkdown(uptime)}\n`;

  if (SKU_LIST.length === 0 || Object.keys(lastLogs).length === 0) {
    text += "Collecting data\\.\\.\\.";
    return ctx.replyWithMarkdownV2(text);
  }

  const statusLines = SKU_LIST.map((sku) =>
    formatSkuStatus(sku, lastLogs[sku])
  );
  text += statusLines.join("\n");
  ctx.replyWithMarkdownV2(text);
});

bot.launch();
console.log("Telegram bot started");

// Function to send message to chat
async function sendMessage(text) {
  if (!CHAT_ID) {
    console.log(`Message (CHAT_ID not specified): ${text}`);
    return;
  }

  try {
    await bot.telegram.sendMessage(CHAT_ID, text, {
      parse_mode: "MarkdownV2",
    });
  } catch (err) {
    console.error("Error sending message to Telegram:", err.message);
  }
}

// Function to escape MarkdownV2
function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

// Helper function to format status message for SKU
function formatSkuStatus(sku, log) {
  if (!log) {
    return `${escapeMarkdown(sku)}: no data`;
  }

  const timeAgo = escapeMarkdown(ago(log.timestamp));
  const escapedSku = escapeMarkdown(sku);

  if (log.error) {
    return `${escapedSku}: ❌ Error \\(${timeAgo}\\)\n   ${escapeMarkdown(
      log.error
    )}`;
  }
  if (log.status === "not_found") {
    return `${escapedSku}: ⚠️ SKU not found \\(${timeAgo}\\)`;
  }
  if (log.status === "available") {
    return `${escapedSku}: ✅ In stock ${escapeMarkdown(
      String(log.price)
    )} \\(${timeAgo}\\)`;
  }
  return `${escapedSku}: ❌ Out of stock \\(${timeAgo}\\)`;
}

// Helper function to create stock notification message
function createStockMessage(sku, price, locale) {
  const marketplaceUrl = `https://marketplace.nvidia.com/${locale}/consumer/graphics-cards/`;
  return `✅ IN STOCK\\! \nSKU: ${escapeMarkdown(
    sku
  )}\nLocale: ${escapeMarkdown(locale)}\nPrice: ${escapeMarkdown(
    price
  )}\nLink: ${escapeMarkdown(marketplaceUrl)}`;
}

// Helper function to create log entry
function createLogEntry(status, error = null, price = null) {
  return {
    timestamp: new Date(),
    status,
    ...(error && { error }),
    ...(price && { price }),
  };
}

// Helper function to check SKU availability
async function checkSku(sku) {
  const url = `${API_BASE_URL}?skus=${sku}&locale=${LOCALE}`;

  try {
    const res = await axios.get(url, {
      timeout: API_TIMEOUT,
      headers: HTTP_HEADERS,
    });

    if (!res.data?.success) {
      lastLogs[sku] = createLogEntry("error", "API returned success: false");
      console.error(`Error checking ${sku}: API returned success: false`);
      return null;
    }

    if (res.data.listMap === null) {
      lastLogs[sku] = createLogEntry("not_found");
      if (errorNotificationsEnabled) {
        await sendMessage(
          `⚠️ *SKU not found*\n*${escapeMarkdown(
            sku
          )}* is no longer valid\\.\nLocale: ${escapeMarkdown(
            LOCALE
          )}\nPlease check the current SKU and update SKU_LIST variable in \\.env`
        );
      }
      return null;
    }

    if (!Array.isArray(res.data.listMap) || res.data.listMap.length === 0) {
      const errorMsg = "listMap is empty or not an array";
      lastLogs[sku] = createLogEntry("error", errorMsg);
      console.error(`Error checking ${sku}: ${errorMsg}`);
      if (errorNotificationsEnabled) {
        await sendMessage(
          `⚠️ *SKU check error*\n*${escapeMarkdown(
            sku
          )}*: listMap is empty or invalid\\.\nLocale: ${escapeMarkdown(
            LOCALE
          )}\nPlease check the SKU and API response\\.`
        );
      }
      return null;
    }

    return res.data.listMap[0];
  } catch (err) {
    const errorMsg = err.message || "Unknown error";
    lastLogs[sku] = createLogEntry("error", errorMsg);
    console.error(`Error checking ${sku}:`, errorMsg);
    return null;
  }
}

// === Main check function ===
async function checkSkuAndProcess(sku) {
  const item = await checkSku(sku);

  if (item) {
    const isAvailable = item.is_active === "true";
    lastLogs[sku] = createLogEntry(
      isAvailable ? "available" : "unavailable",
      null,
      item.price
    );

    if (isAvailable && stockNotificationsEnabled) {
      await sendMessage(createStockMessage(sku, item.price, LOCALE));
    }
  }
}

// Main monitoring loop - polls SKUs sequentially with CHECK_INTERVAL_SEC between each request
async function startMonitoring() {
  let currentIndex = 0;

  while (true) {
    const sku = SKU_LIST[currentIndex];
    await checkSkuAndProcess(sku);

    // Move to next SKU (cycle back to first after last)
    currentIndex = (currentIndex + 1) % SKU_LIST.length;

    // Wait CHECK_INTERVAL_SEC before next request
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
  }
}

// Start monitoring
startMonitoring();

// === Web server for Render (to keep service alive) ===
const app = express();
app.get("/", (req, res) =>
  res.send("NVIDIA FE monitor alive | /status /stock")
);
app.listen(process.env.PORT || 3000, () => {
  console.log("Web server running");
});
