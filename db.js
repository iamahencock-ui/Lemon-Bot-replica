// ---------------------------------------------------------------------------
// db.js — simple JSON-file persistence. No native modules, no compiler needed.
// Stores everything in adbot.json next to the bot. Fine for a single server;
// for very large scale you'd swap this for a real database, but the exported
// API is identical so nothing else has to change.
// ---------------------------------------------------------------------------
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { levelForXp, levelRow } from "./levels.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets the JSON store live on a persistent volume (e.g. Railway's
// /data mount) so data survives redeploys. Defaults to the bot's folder.
const DATA_DIR = process.env.DATA_DIR || __dirname;
mkdirSync(DATA_DIR, { recursive: true });
const FILE = join(DATA_DIR, "adbot.json");

let data = {
  users: {},
  hashes: [],
  tickets: [],
  ads: [],
  nextAdId: 1,
  guilds: {},
};
if (existsSync(FILE)) {
  try {
    data = JSON.parse(readFileSync(FILE, "utf8"));
    data.users ??= {};
    data.hashes ??= [];
    data.tickets ??= [];
    data.ads ??= [];
    data.guilds ??= {};
    data.nextAdId ??=
      (data.ads.reduce((m, a) => Math.max(m, a.id), 0) || 0) + 1;
  } catch {
    console.error("adbot.json was corrupt; starting fresh.");
  }
}

function save() {
  writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function blankUser(discordId) {
  return {
    discord_id: discordId,
    ign: null,
    xp: 0,
    balance: 0,
    earned_ads: 0, // since last withdraw
    earned_bonus: 0, // since last withdraw
    all_time_total: 0,
    total_ads: 0,
    staff_granted: 0,
    last_ad_at: 0,
    rewarded_level: 1, // highest level whose reward has been paid (high-water mark)
  };
}

// --- Users -----------------------------------------------------------------
export function getUser(discordId) {
  if (!data.users[discordId]) {
    data.users[discordId] = blankUser(discordId);
    save();
  }
  return data.users[discordId];
}

export function setIgn(discordId, ign) {
  const u = getUser(discordId);
  u.ign = ign;
  save();
  return u;
}

// Record the base reward for one ad (XP + flat cash). Level-up bonuses are
// handled separately by grantLevelRewards() so they apply no matter how a
// user's XP changes (ads, admin overrides, etc.).
export function recordAdReward({ discordId, xpGain, adCash, now }) {
  const u = getUser(discordId);
  u.xp += xpGain;
  u.balance += adCash;
  u.earned_ads += adCash;
  u.all_time_total += adCash;
  u.total_ads += 1;
  u.last_ad_at = now;
  save();
  return u;
}

// Pay out any level rewards the user has reached but not yet been granted.
// Idempotent: uses rewarded_level as a high-water mark, so calling it twice
// never double-pays. Returns what was granted this call.
export function grantLevelRewards(discordId) {
  const u = getUser(discordId);
  const curLevel = levelForXp(u.xp);
  const from = u.rewarded_level ?? 1;
  let cash = 0;
  let staff = false;
  const levels = [];
  for (let l = from + 1; l <= curLevel; l++) {
    const row = levelRow(l);
    levels.push(l);
    if (row.reward === "STAFF_ROLE") staff = true;
    else if (typeof row.reward === "number") cash += row.reward;
  }
  if (levels.length) {
    u.balance += cash;
    u.all_time_total += cash;
    u.earned_bonus += cash;
    if (staff) u.staff_granted = 1;
    u.rewarded_level = curLevel;
    save();
  }
  return { cash, staff, levels, newLevel: curLevel };
}

export function withdraw(discordId) {
  const u = getUser(discordId);
  const amount = u.balance;
  u.balance = 0;
  u.earned_ads = 0;
  u.earned_bonus = 0;
  save();
  return amount; // amount withdrawn
}

// Admin override: merge arbitrary fields onto a user row.
export function adminSet(discordId, fields) {
  const u = getUser(discordId);
  Object.assign(u, fields);
  save();
  return u;
}

// Admin override: wipe a user back to a clean slate.
export function resetUser(discordId) {
  data.users[discordId] = blankUser(discordId);
  save();
  return data.users[discordId];
}

// --- Ad-hash store (duplicate detection) -----------------------------------
export function allHashes() {
  return data.hashes.map((h) => ({ discord_id: h.discord_id, hash: h.hash }));
}

export function saveHash(discordId, hash, messageId, now) {
  data.hashes.push({
    discord_id: discordId,
    hash,
    message_id: messageId,
    created_at: now,
  });
  save();
}

// Wipe the whole duplicate-detection cache. Returns how many were cleared.
export function clearHashes() {
  const n = data.hashes.length;
  data.hashes = [];
  save();
  return n;
}

// Clear only one user's cached screenshot hashes.
export function clearUserHashes(discordId) {
  const before = data.hashes.length;
  data.hashes = data.hashes.filter((h) => h.discord_id !== discordId);
  const n = before - data.hashes.length;
  save();
  return n;
}

// --- DC Treasury API token (auto-rotated) ----------------------------------
export function getApiToken() {
  return data.apiToken || null;
}
export function setApiToken(token) {
  data.apiToken = token;
  save();
}

// --- Per-guild config (set by the first-run setup) -------------------------
export function getGuildConfig(guildId) {
  return data.guilds[guildId] ?? {};
}

export function setGuildConfig(guildId, fields) {
  data.guilds[guildId] = { ...(data.guilds[guildId] ?? {}), ...fields };
  save();
  return data.guilds[guildId];
}

// --- Ads (the running ad list) ---------------------------------------------
export function addAd(text, createdBy) {
  const ad = {
    id: data.nextAdId++,
    text,
    active: true,
    created_by: createdBy,
    created_at: Date.now(),
  };
  data.ads.push(ad);
  save();
  return ad;
}

export function removeAd(id) {
  const i = data.ads.findIndex((a) => a.id === id);
  if (i === -1) return null;
  const [removed] = data.ads.splice(i, 1);
  save();
  return removed;
}

export function setAdActive(id, active) {
  const ad = data.ads.find((a) => a.id === id);
  if (!ad) return null;
  ad.active = active;
  save();
  return ad;
}

export function listAds(activeOnly = false) {
  return activeOnly ? data.ads.filter((a) => a.active) : data.ads.slice();
}

// --- Tickets ---------------------------------------------------------------
export function createTicket(channelId, userId, now) {
  data.tickets.push({
    channel_id: channelId,
    user_id: userId,
    open: true,
    created_at: now,
  });
  save();
}

export function isTicketChannel(channelId) {
  return data.tickets.some((t) => t.channel_id === channelId && t.open);
}

export function getOpenTicketByUser(userId) {
  return data.tickets.find((t) => t.user_id === userId && t.open) ?? null;
}

export function closeTicket(channelId) {
  const t = data.tickets.find((x) => x.channel_id === channelId && x.open);
  if (t) {
    t.open = false;
    save();
  }
  return t;
}
