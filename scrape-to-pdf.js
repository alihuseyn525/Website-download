#!/usr/bin/env node

/**
 * scrape-to-pdf.js
 *
 * Opens a URL in a headless browser, finds every image on the page
 * (including lazy-loaded and CSS background images), downloads them,
 * and compiles them into a single PDF.
 *
 * Usage:
 *   node scrape-to-pdf.js <url> [outputName]
 *
 * Example:
 *   node scrape-to-pdf.js https://example.com/gallery my-gallery.pdf
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const https = require("https");
const http = require("http");
const { PDFDocument } = require("pdf-lib");

const url = process.argv[2];
const outputName = process.argv[3] || "output.pdf";

if (!url) {
  console.error("Usage: node scrape-to-pdf.js <url> [outputName]");
  process.exit(1);
}

const TMP_DIR = path.join(__dirname, "downloaded-images");
const MIN_WIDTH = 200; // skip tiny icons/spacers
const MIN_HEIGHT = 200;
const MAX_ASPECT_RATIO = 4; // skip banners/strips wider or taller than this ratio

// Keywords in the URL, filename, alt text, or class/id that usually mean
// "this isn't real content" (logos, icons, ads, tracking pixels, etc.)
const SKIP_KEYWORDS = [
  "logo", "icon", "favicon", "sprite", "badge", "avatar", "profile-pic",
  "banner", "advert", "/ads/", "-ad-", "_ad_", "adserver", "doubleclick",
  "sponsor", "promo", "pixel", "tracking", "beacon", "spacer", "placeholder",
  "thumb-", "thumbnail-small", "social-icon", "share-icon", "button",
  "arrow-", "chevron", "close-icon", "menu-icon", "nav-icon", "loading",
  "spinner", "watermark",
];

// Domains commonly used for ads, trackers, and analytics — skip images
// served from these even if they don't match a keyword above.
const SKIP_DOMAINS = [
  "doubleclick.net", "googlesyndication.com", "googletagmanager.com",
  "google-analytics.com", "facebook.com/tr", "adservice.google",
  "amazon-adsystem.com", "adnxs.com", "criteo.com", "taboola.com",
  "outbrain.com", "scorecardresearch.com", "quantserve.com", "moatads.com",
];

function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const client = fileUrl.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    client
      .get(fileUrl, (response) => {
        // Follow one redirect hop if needed
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlink(destPath, () => {});
          return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          return reject(new Error(`Status ${response.statusCode} for ${fileUrl}`));
        }
        response.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

async function autoScroll(page) {
  // Scrolls to the bottom gradually to trigger lazy-loaded images
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

async function extractImageUrls(page) {
  const raw = await page.evaluate((minW, minH, maxAspect) => {
    // Returns candidates with metadata; filtering by keyword/domain/
    // repetition happens back in Node so we can share the keyword list.
    const candidates = [];
    const seen = new Set();

    function pushCandidate(src, w, h, altText, classAndId) {
      if (!src || !src.startsWith("http") || seen.has(src)) return;
      if (w && h) {
        if (w < minW || h < minH) return;
        const ratio = Math.max(w / h, h / w);
        if (ratio > maxAspect) return;
      }
      seen.add(src);
      candidates.push({ src, altText: altText || "", classAndId: classAndId || "" });
    }

    // 1. <img> tags (use largest available via srcset when present)
    document.querySelectorAll("img").forEach((img) => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;

      let src = img.currentSrc || img.src;
      if (img.srcset) {
        const candidatesList = img.srcset.split(",").map((s) => s.trim().split(" ")[0]);
        if (candidatesList.length) src = candidatesList[candidatesList.length - 1];
      }
      const classAndId = `${img.className || ""} ${img.id || ""}`;
      pushCandidate(src, w, h, img.alt, classAndId);
    });

    // 2. CSS background-image
    document.querySelectorAll("*").forEach((el) => {
      const bg = window.getComputedStyle(el).backgroundImage;
      const match = bg && bg.match(/url\(["']?(.*?)["']?\)/);
      if (match && match[1]) {
        const rect = el.getBoundingClientRect();
        const classAndId = `${el.className || ""} ${el.id || ""}`;
        pushCandidate(match[1], rect.width, rect.height, "", classAndId);
      }
    });

    return candidates;
  }, MIN_WIDTH, MIN_HEIGHT, MAX_ASPECT_RATIO);

  // Keyword + domain filtering (Node side, shares the constants above)
  const filtered = raw.filter(({ src, altText, classAndId }) => {
    const haystack = `${src} ${altText} ${classAndId}`.toLowerCase();
    if (SKIP_KEYWORDS.some((kw) => haystack.includes(kw))) return false;
    if (SKIP_DOMAINS.some((domain) => src.toLowerCase().includes(domain))) return false;
    return true;
  });

  console.log(`  Filtered out ${raw.length - filtered.length} likely logos/icons/ads.`);
  return filtered.map((c) => c.src);
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

  console.log(`Launching browser...`);
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );

  console.log(`Opening ${url} ...`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  console.log("Scrolling to trigger lazy-loaded images...");
  await autoScroll(page);
  await new Promise((r) => setTimeout(r, 1500)); // let final images settle

  console.log("Extracting image URLs...");
  const imageUrls = await extractImageUrls(page);
  console.log(`Found ${imageUrls.length} candidate images.`);

  await browser.close();

  if (imageUrls.length === 0) {
    console.log("No images found. Exiting.");
    return;
  }

  console.log("Downloading images...");
  const downloaded = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const imgUrl = imageUrls[i];
    const ext = (imgUrl.split(".").pop().split("?")[0] || "jpg").toLowerCase();
    const safeExt = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext) ? ext : "jpg";
    const destPath = path.join(TMP_DIR, `img_${String(i).padStart(3, "0")}.${safeExt}`);
    try {
      await downloadFile(imgUrl, destPath);
      downloaded.push(destPath);
      console.log(`  [${i + 1}/${imageUrls.length}] downloaded`);
    } catch (err) {
      console.log(`  [${i + 1}/${imageUrls.length}] failed: ${err.message}`);
    }
  }

  console.log(`Downloaded ${downloaded.length} images. Building PDF...`);
  await buildPdf(downloaded, outputName);
  console.log(`Done. Saved to ${outputName}`);
}

async function buildPdf(imagePaths, outputName) {
  const pdfDoc = await PDFDocument.create();

  for (const imgPath of imagePaths) {
    try {
      const imgBytes = fs.readFileSync(imgPath);
      const ext = path.extname(imgPath).toLowerCase();

      let embeddedImage;
      if (ext === ".png") {
        embeddedImage = await pdfDoc.embedPng(imgBytes);
      } else if (ext === ".jpg" || ext === ".jpeg") {
        embeddedImage = await pdfDoc.embedJpg(imgBytes);
      } else {
        // pdf-lib only natively supports png/jpg; skip other formats
        console.log(`  Skipping unsupported format for PDF: ${imgPath}`);
        continue;
      }

      const { width, height } = embeddedImage;
      const pageW = 612; // US Letter width in points
      const pageH = 792;
      const scale = Math.min(pageW / width, pageH / height, 1);
      const drawW = width * scale;
      const drawH = height * scale;

      const page = pdfDoc.addPage([pageW, pageH]);
      page.drawImage(embeddedImage, {
        x: (pageW - drawW) / 2,
        y: (pageH - drawH) / 2,
        width: drawW,
        height: drawH,
      });
    } catch (err) {
      console.log(`  Error embedding ${imgPath}: ${err.message}`);
    }
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputName, pdfBytes);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
