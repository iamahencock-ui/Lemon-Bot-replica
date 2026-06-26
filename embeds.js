// ---------------------------------------------------------------------------
// embeds.js — builds the Discord embeds for Gnomeads. Gnice and tidy.
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
    .setTitle(leveled ? "🆙 Level up! Gnicely done!" : "🍄 Ad gnoted — gnice work!")
    .setDescription(
      [
        `⭐ **Gnome rank:** ${levelText}`,
        `${progressBar(p.pct)}  ${p.pct}%`,
        `${p.current} / ${p.needed} XP`,
        "",
        `🎁 **Next bonus:** ${
          p.atMax ? "— (top of the toadstool)" : cur(nextBonus(user.xp))
        }`,
        "",
        "⏰ **SINCE LAST WITHDRAW:**",
        `💰 Earned from ads: ${cur(user.earned_ads)}${delta(adCash)}`,
        `🎉 Earned from bonuses: ${cur(user.earned_bonus)}${delta(bonusCash)}`,
        `📊 Burrow balance: ${cur(user.balance)}${delta(adCash + bonusCash)}`,
        "",
        `📅 All-time total: ${cur(user.all_time_total)}`,
        `🍄 Ads gnomed: ${user.total_ads} (${user.xp} XP)`,
      ].join("\n")
    );

  if (result.grantedStaffRole) {
    e.addFields({
      name: "🎖️ Gnoble promotion!",
      value: "You've climbed to staff rank and earned the gnome staff role!",
    });
  }
  if (user.ign) e.setFooter({ text: `Gname: ${user.ign}` });
  return e;
}

// !rewards — the full level table with a "You are here" marker.
export function rewardsEmbed(user) {
  const myLevel = levelForXp(user.xp);

  const fmtReward = (r) => (r === "STAFF_ROLE" ? "Gnome staff role + 🎖️" : cur(r));

  const lines = (rows) =>
    rows
      .map((r) => {
        const here = r.level === myLevel ? "  ⬅️ **You're gnesting here**" : "";
        return `**Rank ${r.level}** (${r.xp} XP) — ${fmtReward(r.reward)}${here}`;
      })
      .join("\n");

  const e = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("🎁 Gnome rewards")
    .setDescription(`Your current rank: **${myLevel}**`);

  // Chunk into fields of 10 to stay under embed limits.
  for (let i = 0; i < LEVELS.length; i += 10) {
    const chunk = LEVELS.slice(i, i + 10);
    e.addFields({
      name: `Ranks ${chunk[0].level}–${chunk[chunk.length - 1].level}`,
      value: lines(chunk),
    });
  }
  return e;
}

// Duplicate / flagged submission.
export function flaggedEmbed(match) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🚫 Gnope — I've seen this one")
    .setDescription(
      [
        "That screenshot matches one already submitted, so no gnome points this time.",
        `Match distance: \`${match.distance}\` bit(s) (threshold ${config.dupeHammingThreshold}).`,
        "Send a **fresh** screenshot of your ad showing the whole screen.",
      ].join("\n")
    );
}

// Rejected for not being a full-screen capture.
export function notFullScreenEmbed(reason) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🖼️ Gnot the whole screen")
    .setDescription(`I need a screenshot of the **entire screen**, gnome — ${reason}`);
}

// The screenshot didn't match any running ad.
export function adNotFoundEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🚫 That ad doesn't ring a gnell")
    .setDescription(
      "That screenshot doesn't match any of the **currently running ads**.\n" +
        "Run `!ad` to grab the exact text, paste one into `/ad` in-game, wait for the " +
        "**AD »** broadcast to pop up, then screenshot the **whole screen** showing it. Gnice and clear!"
    );
}

// Submitter's IGN wasn't found in the screenshot.
export function ignMissingEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🚫 Can't spot your gname")
    .setDescription(
      "I matched the ad, but couldn't see your in-game gname in the screenshot. " +
        "Make sure the **AD »** line (which ends with your username) is fully visible."
    );
}

// !ad — list the currently running ads.
export function adsListEmbed(ads) {
  const e = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("📢 Ads worth gnoming about")
    .setDescription(
      "Grab one of these, run it in-game with `/ad`, then screenshot the whole screen here. Get gnoming!"
    );
  for (const ad of ads.slice(0, 25)) {
    const left =
      ad.cap > 0
        ? `  ·  ${Math.max(0, ad.cap - (ad.runs || 0))} runs left`
        : "";
    e.addFields({
      name: `Ad #${ad.id}${left}`,
      value: "```\n" + ad.text + "\n```",
    });
  }
  return e;
}

// A matched ad has used up its paid runs.
export function adFullEmbed() {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("🍄 That ad's all gnomed out")
    .setDescription(
      "This ad has used up all its paid runs, so it won't earn right now. Grab a different one from `!ad`!"
    );
}

// !ad — when there's nothing to advertise yet.
export function noAdsEmbed() {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("📭 Gnothing to gnome right now")
    .setDescription("No ads are sprouting at the moment. Check back soon — the garden's growing!");
}

// Too many submissions queued — ask the user to retry shortly.
export function busyEmbed() {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("⏳ The gnomes are swamped")
    .setDescription(
      "Lots of screenshots are being checked right now. Give it a minute and post yours again."
    );
}

// OCR failed to read the image at all.
export function unreadableEmbed() {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("🔍 Can't make heads or tails of it")
    .setDescription(
      "That image was too blurry or tiny for the gnomes to read. Send a clear, full-screen capture and try again."
    );
}

// Short anti-spam cooldown still active.
export function cooldownEmbed(msLeft) {
  const total = Math.ceil(msLeft / 1000);
  const t = total >= 60 ? `${Math.floor(total / 60)}m ${total % 60}s` : `${total}s`;
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("⏳ Easy there, gnome!")
    .setDescription(`Catch your breath — your next ad in **${t}**.`);
}
