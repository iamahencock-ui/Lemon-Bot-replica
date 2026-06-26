// ---------------------------------------------------------------------------
// levels.js — pure XP/level math. No DB, no Discord. Easy to unit-test.
// ---------------------------------------------------------------------------
import { LEVELS } from "./config.js";

// Highest level whose XP requirement is met by `xp`.
export function levelForXp(xp) {
  let lvl = LEVELS[0];
  for (const row of LEVELS) {
    if (xp >= row.xp) lvl = row;
    else break;
  }
  return lvl.level;
}

export function levelRow(level) {
  return LEVELS.find((l) => l.level === level) ?? LEVELS[LEVELS.length - 1];
}

export function nextLevelRow(level) {
  return LEVELS.find((l) => l.level === level + 1) ?? null;
}

// Progress within the current level: { current, needed, pct } where `current`
// is XP earned since entering this level and `needed` is the span to next level.
// At max level, needed = 0 and pct = 100.
export function progress(xp) {
  const level = levelForXp(xp);
  const cur = levelRow(level);
  const next = nextLevelRow(level);
  if (!next) return { current: 0, needed: 0, pct: 100, atMax: true };
  const current = xp - cur.xp;
  const needed = next.xp - cur.xp;
  const pct = needed === 0 ? 100 : Math.floor((current / needed) * 100);
  return { current, needed, pct, atMax: false };
}

// The cash value shown as "Next Bonus" = reward for the next level (or 0/role).
export function nextBonus(xp) {
  const next = nextLevelRow(levelForXp(xp));
  if (!next) return 0;
  return typeof next.reward === "number" ? next.reward : 0;
}

// Apply one ad's worth of XP. Returns a result describing what happened,
// including every level crossed (an ad can cross more than one) and the total
// bonus cash + whether a staff-role reward was hit.
export function applyAd(prevXp, xpGain) {
  const newXp = prevXp + xpGain;
  const prevLevel = levelForXp(prevXp);
  const newLevel = levelForXp(newXp);

  let bonusCash = 0;
  let grantedStaffRole = false;
  const crossed = [];
  for (let l = prevLevel + 1; l <= newLevel; l++) {
    const row = levelRow(l);
    crossed.push(l);
    if (row.reward === "STAFF_ROLE") grantedStaffRole = true;
    else if (typeof row.reward === "number") bonusCash += row.reward;
  }

  return {
    prevXp,
    newXp,
    prevLevel,
    newLevel,
    leveledUp: newLevel > prevLevel,
    crossedLevels: crossed,
    bonusCash,
    grantedStaffRole,
  };
}

// Simple text progress bar for embeds, e.g. "████░░░░░░ 40%".
export function progressBar(pct, slots = 10) {
  const filled = Math.round((pct / 100) * slots);
  return "█".repeat(filled) + "░".repeat(slots - filled);
}
