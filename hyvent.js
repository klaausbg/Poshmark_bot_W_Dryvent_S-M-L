require("dotenv").config();
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const puppeteer = require("puppeteer");

const { ensureTable, isSeen, markAsSeen } = require("./db_hyvent");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POSHMARK_URL =
  "https://poshmark.com/search?query=the%20north%20face%20dryvent&sort_by=added_desc&brand%5B%5D=The%20North%20Face&department=Women&category=Jackets_%26_Coats&price%5B%5D=-35&size%5B%5D=M&size%5B%5D=S&size%5B%5D=L";

// ------------------------------------------------------
// ✅ FIXED TELEGRAM FUNCTION
// ------------------------------------------------------
async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  console.log("📲 Sending message to Telegram:", message);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        // ❌ REMOVED parse_mode to prevent Markdown errors
        disable_web_page_preview: false,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      console.error("❌ Telegram API error:", data.description);
      throw new Error(data.description); // 🔥 tell caller it FAILED
    }

    console.log("📬 Telegram OK:", data.result.message_id);
    return true;
  } catch (error) {
    console.error("❌ Failed to send Telegram message:", error);
    throw error; // 🔥 propagate error so we don't mark as seen
  }
}

// ------------------------------------------------------
// SCRAPER
// ------------------------------------------------------
async function checkPoshmark() {
  console.log("⏳ Launching Puppeteer...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 60000,
  });
  const page = await browser.newPage();

  console.log("🌐 Navigating to Poshmark...");
  await page.goto(POSHMARK_URL, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Scroll to load listings
  let previousHeight = 0;
  const maxScrolls = 10;

  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });

    const newHeight = await page.evaluate(() => document.body.scrollHeight);

    if (newHeight === previousHeight) break;

    previousHeight = newHeight;
    console.log(`⬇️ Scrolled ${i + 1} times...`);
  }

  console.log("🧽 Scraping listing links...");
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a.tile__covershot")).map(
      (a) => "https://poshmark.com" + a.getAttribute("href")
    );
  });

  console.log(`🔗 Found ${links.length} links`);
  let matchCount = 0;
  const maxMatches = 10;
  let firstMatch = true;

  for (let i = 0; i < links.length && matchCount < maxMatches; i++) {
    const url = links[i];

    if (await isSeen(url)) {
      console.log("🔁 Already sent, skipping:", url);
      continue;
    }

    const productPage = await browser.newPage();

    try {
      console.log(`🔍 Visiting ${url}`);
      await productPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await new Promise((r) => setTimeout(r, 3000));

      const item = await productPage.evaluate(() => {
        const title = document
          .querySelector("h1.listing__title-container")
          ?.innerText?.trim();
        const rawPrice = document.querySelector("p.h1")?.innerText?.trim();
        const price = rawPrice?.match(/\$\d+/)?.[0];
        const size = document
          .querySelector("button.size-selector__size-option")
          ?.innerText?.trim();
        return { title, price, size };
      });

      item.link = url;

      if (item.title && item.price && item.size) {
        const numericPrice = parseFloat(item.price.replace("$", ""));
        const flaws = ["flaw", "flaws", "flawed", "polartec", "vest", "stain", "damaged"];

        if (!flaws.some((word) => item.title.toLowerCase().includes(word))) {
          // Header message once
          if (firstMatch) {
            try {
              await sendTelegramMessage("\u2063");
              await sendTelegramMessage(
                "🔔 You got new deals!\n\nHere are the latest Women DryVent Jackets:"
              );
            } catch {}
            firstMatch = false;
          }

          // ------------------------------------------------------
          // ✅ FIXED MESSAGE (NO MARKDOWN)
          // ------------------------------------------------------
          const message = `🧥 ${item.title}\n💰 ${numericPrice}\n📏 Size: ${item.size}\n🔗 ${item.link}`;

          // ------------------------------------------------------
          // ✅ SEND + SAFE markAsSeen
          // ------------------------------------------------------
          try {
            await sendTelegramMessage(message);
            await markAsSeen(item.link);
            matchCount++;
            console.log(`✅ Sent to Telegram (${matchCount}/${maxMatches})`);
          } catch (err) {
            console.warn(
              "⚠️ Failed to send message — NOT marking as seen:",
              err.message
            );
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ Failed on ${url}:`, err.message);
    } finally {
      await productPage.close();
    }
  }

  await browser.close();
  console.log(`📦 Final matches sent: ${matchCount}`);
}

async function main() {
  await ensureTable();
  await checkPoshmark();
}

main();
