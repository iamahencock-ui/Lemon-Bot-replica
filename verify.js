// ---------------------------------------------------------------------------
// verify.js — proves a submission is (a) a real full-screen capture and
// (b) actually shows the user's ad broadcast in chat.
//
// (a) is a resolution + aspect-ratio heuristic (a cropped chat box fails it).
// (b) uses OCR (tesseract.js, pure JS/WASM — no compiler) to read the chat
//     text and look for the AD broadcast keyword + the submitter's IGN.
// ---------------------------------------------------------------------------
import { createWorker } from "tesseract.js";
import sharp from "sharp";

// One reused OCR worker for the life of the process.
let workerPromise = null;
function worker() {
  if (!workerPromise) workerPromise = createWorker("eng");
  return workerPromise;
}

// Collapse to lowercase alphanumerics so OCR noise (spaces, », |, etc.) and
// case don't break "contains" checks.
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Read all text from the screenshot. Small in-game chat text reads far better
// when upscaled, so enlarge to ~1920px wide, then grayscale/normalize/sharpen.
export async function ocrText(buffer) {
  const meta = await sharp(buffer).metadata();
  const targetWidth = Math.max(meta.width || 0, 1920);
  const prepped = await sharp(buffer)
    .resize({ width: targetWidth, withoutEnlargement: false })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
  const w = await worker();
  const { data } = await w.recognize(prepped);
  return data.text || "";
}

// Full-screen heuristic. meta = { width, height }.
export function checkFullScreen(meta, config) {
  if (
    meta.width < config.minImageWidth ||
    meta.height < config.minImageHeight
  ) {
    return {
      ok: false,
      reason: `it's ${meta.width}×${meta.height}px — needs to be at least ${config.minImageWidth}×${config.minImageHeight}px (capture the whole screen, not a crop).`,
    };
  }
  const ratio = meta.width / meta.height;
  if (ratio < config.minAspect || ratio > config.maxAspect) {
    return {
      ok: false,
      reason: `its shape (aspect ${ratio.toFixed(
        2
      )}) looks cropped — send the full monitor screenshot.`,
    };
  }
  return { ok: true };
}

// Common OCR character confusions, folded to one representative each, so an
// IGN like "Moski08" still matches an OCR'd "Mosk1O8".
const CONFUSE = { o: "0", l: "1", i: "1", s: "5", b: "8", z: "2", g: "9" };
const canon = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .split("")
    .map((c) => CONFUSE[c] ?? c)
    .join("");

// Is the user's IGN visible in the screenshot? Tolerant of OCR slips: folds
// look-alike characters, then allows a small edit distance per word.
export function ignPresent(text, ign) {
  if (!ign) return false;
  const target = canon(ign);
  if (!target) return false;
  if (canon(text).includes(target)) return true; // fast path
  const tol = target.length >= 6 ? 2 : 1;
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map(canon)
    .filter(Boolean);
  return tokens.some(
    (t) => Math.abs(t.length - target.length) <= tol && lev(t, target) <= tol
  );
}

// Levenshtein edit distance (small words only, so the simple DP is fine).
function lev(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

// Split into significant lowercase words (drops punctuation + tiny words).
function words(s, minLen) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= minLen);
}

// Find the stored ad that best matches the OCR text. For each ad, count how
// many of its significant words appear in the screenshot (exact, or within a
// small edit distance to forgive OCR slips). Score = matched / total words.
// Returns the best { ad, score, matched, total } at or above `threshold`, else null.
export function bestAdMatch(text, ads, { minWordLen = 3, threshold = 0.6 } = {}) {
  const ocr = words(text, minWordLen);
  const ocrSet = new Set(ocr);
  let best = null;

  for (const ad of ads) {
    const aw = words(ad.text, minWordLen);
    if (!aw.length) continue;
    let matched = 0;
    for (const w of aw) {
      if (ocrSet.has(w)) {
        matched++;
        continue;
      }
      const tol = w.length >= 6 ? 2 : 1; // forgive 1–2 char OCR errors
      if (ocr.some((o) => Math.abs(o.length - w.length) <= tol && lev(o, w) <= tol)) {
        matched++;
      }
    }
    const score = matched / aw.length;
    if (!best || score > best.score) {
      best = { ad, score, matched, total: aw.length };
    }
  }

  return best && best.score >= threshold ? best : null;
}
