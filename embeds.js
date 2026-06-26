// ---------------------------------------------------------------------------
// embeds.js — builds the Discord embeds, styled after the Lemonade bot.
// ---------------------------------------------------------------------------
import { EmbedBuilder } from "discord.js";
import { config, LEVELS } from "./config.js";
import {
  progress,
  progressBar,
  nextBonus,
  levelForXp,
} from "./levels.js";

const cur = (n) => `${config.currencySymbol}${n.toLocaleString()}`;
const delta = (n) => (n > 0 ? ` (+${cur(n)})` : "");

// Post-ad embed. Shows "Level Up!" styling when a level was crossed, otherwise
// the standard "Ad Recorded!" card. `result` comes from levels.applyAd().
export function adEmbed(user, result, { xpGain, adCash, bonusCash }) {
  const p = progress(user.xp);
  const leveled = result.leveledUp;

  const levelText = leveled
    ? `${result.prevLevel} → ${result.newLevel}`
    : `${result.newLevel}`;

  const e = new EmbedBuilder()
    .setColor(leveled ? 0x57f287 : 0xf1c40f)
    .setTitle(leveled ? "🆙 Level Up!" : "📸 Ad Recorded!")
    .setDescription(
      [
        `⭐ **Level:** ${levelText}`,
        `${progressBar(p.pct)}  ${p.pct}%`,
        `${p.current} / ${p.needed} XP`,
        "",
        `🎁 **Next Bonus:** ${
          p.atMax ? "— (max level)" : cur(nextBonus(user.xp))
        }`,
        "",
        "⏰ **SINCE LAST WITHDRAW:**",
        `💰 Earned from Ads: ${cur(user.earned_ads)}${delta(adCash)}`,
        `🎉 Earned from Bonus: ${cur(user.earned_bonus)}${delta(bonusCash)}`,
        `📊 Account balance: ${cur(user.balance)}${delta(adCash + bonusCash)}`,
        "",
        `📅 All-Time Total: ${cur(user.all_time_total)}`,
        `🦮 Total Ads: ${user.total_ads} (${user.xp} XP)`,
      ].join("\n")
    );

  if (result.grantedStaffRole) {
    e.addFields({
      name: "🎖️ Staff reward",
      value: "You reached the staff level and earned the staff role!",
    });
  }
  if (user.ign) e.setFooter({ text: `IGN: ${user.ign}` });
  return e;
}

// !rewards — the full level table with a "You are here" marker.
export function rewardsEmbed(user) {
  const myLevel = levelForXp(user.xp);

  const fmtReward = (r) => (r === "STAFF_ROLE" ? "Staff role + 🎖️" : cur(r));

  const lines = (rows) =>
    rows
      .map((r) => {
        const here = r.level === myLevel ? "  ⬅️ **You are here**" : "";
        return `**Lvl ${r.level}** (${r.xp} XP) — ${fmtReward(r.reward)}${here}`;
      })
      .join("\n");

  const e = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("🎁 Level Rewards")
    .setDescription(`Your current level: **${myLevel}**`);

  // Chunk into fields of 10 to stay under embed limits.
  for (let i = 0; i < LEVELS.length; i += 10) {
    const chunk = LEVELS.slice(i, i + 10);
    e.addFields({
      name: `Levels ${chunk[0].level}–${chunk[chunk.length - 1].level}`,
      value: lines(chunk),
    });
  }
  return e;
}

// Duplicate / flagged submission.
export function flaggedEmbed(match) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🚫 Duplicate screenshot flagged")
    .setDescription(
      [
        "That screenshot matches one already submitted, so it wasn't counted.",
        `Match distance: \`${match.distance}\` bit(s) (threshold ${config.dupeHammingThreshold}).`,
        "Post a **fresh** screenshot of your ad showing the entire screen.",
      ].join("\n")
    );
}

// Rejected for not being a full-screen capture.
export function notFullScreenEmbed(reason) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🖼️ Screenshot rejected")
    .setDescription(`Send a screenshot of the **entire screen** — ${reason}`);
}

// The screenshot didn't match any running ad.
export function adNotFoundEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🚫 Ad didn't match")
    .setDescription(
      "That screenshot doesn't match any of the **currently running ads**.\n" +
        "Run `!ad` to see the exact text, paste one into `/ad` in-game, wait for the " +
        "**AD »** broadcast to appear, then screenshot the **whole screen** showing it."
    );
}

// Submitter's IGN wasn't found in the screenshot.
export function ignMissingEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🚫 IGN not found")
    .setDescription(
      "I matched the ad, but couldn't see your in-game name in the screenshot. " +
        "Make sure the **AD »** line (which ends with your username) is fully visible."
    );
}

// !ad — list the currently running ads.
export function adsListEmbed(ads) {
  const e = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("📢 Currently running ads")
    .setDescription(
      "Copy one of these, run it in-game with `/ad`, then screenshot the whole screen here."
    );
  for (const ad of ads.slice(0, 25)) {
    e.addFields({ name: `Ad #${ad.id}`, value: "```\n" + ad.text + "\n```" });
  }
  return e;
}

// !ad — when there's nothing to advertise yet.
export function noAdsEmbed() {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("📭 No ads running")
    .setDescription("There are no ads to run right now. Check back soon!");
}

// OCR failed to read the image at all.
export function unreadableEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🔍 Couldn't read that screenshot")
    .setDescription(
      "The image was too blurry or small to read. Send a clear, full-screen capture and try again."
    );
}

// Cooldown still active.
export function cooldownEmbed(msLeft) {
  const mins = Math.floor(msLeft / 60000);
  const secs = Math.ceil((msLeft % 60000) / 1000);
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("⏳ Slow down!")
    .setDescription(`You can post your next ad in **${mins}m ${secs}s**.`);
}
