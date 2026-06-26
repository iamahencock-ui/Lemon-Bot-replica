// ---------------------------------------------------------------------------
// index.js — the bot. Ticket panel + private ticket channels, ! commands and
// ad-screenshot submissions (size + duplicate verified), XP/cash economy.
// All commands and submissions ONLY work inside ticket channels.
// ---------------------------------------------------------------------------
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { config, LEVELS } from "./config.js";
import * as store from "./db.js";
import { levelForXp } from "./levels.js";
import { dhash, imageMeta, findDuplicate } from "./hashing.js";
import { ocrText, checkFullScreen, bestAdMatch, ignPresent } from "./verify.js";
import { ensureGuildSetup } from "./setup.js";
import {
  adEmbed,
  rewardsEmbed,
  flaggedEmbed,
  notFullScreenEmbed,
  adNotFoundEmbed,
  ignMissingEmbed,
  unreadableEmbed,
  adsListEmbed,
  noAdsEmbed,
  cooldownEmbed,
} from "./embeds.js";

const {
  DISCORD_TOKEN,
  STAFF_ROLE_ID,
  FLAG_LOG_CHANNEL_ID,
  TICKET_CATEGORY_ID,
  PAYOUT_ROLE_ID,
  PAYOUT_CHANNEL_ID,
} = process.env;

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const isImage = (att) =>
  (att.contentType && att.contentType.startsWith("image/")) ||
  IMAGE_RE.test(att.name ?? "") ||
  IMAGE_RE.test(att.url.split("?")[0]);

// Resolve a setting: per-guild config (from auto-setup) first, .env fallback.
const ENV_FALLBACK = {
  staffRoleId: STAFF_ROLE_ID,
  payoutRoleId: PAYOUT_ROLE_ID,
  payoutChannelId: PAYOUT_CHANNEL_ID,
  ticketCategoryId: TICKET_CATEGORY_ID,
  flagLogChannelId: FLAG_LOG_CHANNEL_ID,
};
function gcfg(guildId, key) {
  const gc = store.getGuildConfig(guildId);
  return gc[key] ?? ENV_FALLBACK[key] ?? null;
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  // Provision any servers the bot is already in but hasn't set up yet.
  for (const guild of c.guilds.cache.values()) {
    await ensureGuildSetup(guild, c).catch((e) =>
      console.error("setup error:", e)
    );
  }
});

// Provision a server the moment the bot is added to it.
client.on(Events.GuildCreate, async (guild) => {
  await ensureGuildSetup(guild, client).catch((e) =>
    console.error("setup error:", e)
  );
});

// ===========================================================================
// Messages: commands + ad submissions (gated to ticket channels)
// ===========================================================================
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (msg.author.bot || !msg.guild) return;

    // Commands
    if (msg.content.startsWith(config.prefix)) {
      const [cmd, ...rest] = msg.content
        .slice(config.prefix.length)
        .trim()
        .split(/\s+/);
      const command = cmd.toLowerCase();

      // !setup posts the ticket panel — admins only, works in any channel.
      if (command === "setup") return handleSetup(msg);

      // Admin override commands — admins only, work in any channel.
      if (ADMIN_COMMANDS.has(command)) return handleAdmin(msg, command, rest);

      // Everything else only works inside an open ticket.
      if (!store.isTicketChannel(msg.channel.id)) return;
      return handleCommand(msg, command, rest);
    }

    // Ad screenshot submission — only inside an open ticket.
    const att = msg.attachments.find(isImage);
    if (att && store.isTicketChannel(msg.channel.id)) {
      return handleSubmission(msg, att);
    }
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

// ===========================================================================
// Button interactions: open / close tickets
// ===========================================================================
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.isButton()) return;
    if (i.customId === "ticket_create") return openTicket(i);
    if (i.customId === "ticket_close") return closeTicketBtn(i);
  } catch (err) {
    console.error("interaction error:", err);
  }
});

// --- Ticket panel (admin) --------------------------------------------------
async function handleSetup(msg) {
  if (!msg.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return msg.reply("You need the **Manage Server** permission to run this.");
  }
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(config.panelTitle)
    .setDescription(config.panelDescription);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_create")
      .setLabel("Open a ticket")
      .setEmoji("🎟️")
      .setStyle(ButtonStyle.Success)
  );
  await msg.channel.send({ embeds: [embed], components: [row] });
  // Tidy: remove the admin's "!setup" message if we can.
  msg.delete().catch(() => {});
}

// --- Open a ticket ---------------------------------------------------------
async function openTicket(i) {
  const existing = store.getOpenTicketByUser(i.user.id);
  if (existing) {
    // Self-heal: if that channel was deleted, drop the stale record and continue.
    const stillThere = await i.guild.channels
      .fetch(existing.channel_id)
      .catch(() => null);
    if (stillThere) {
      return i.reply({
        content: `You already have an open ticket: <#${existing.channel_id}>`,
        ephemeral: true,
      });
    }
    store.closeTicket(existing.channel_id);
  }

  const guild = i.guild;
  const ticketCategoryId = gcfg(guild.id, "ticketCategoryId");
  const staffRoleId = gcfg(guild.id, "staffRoleId");
  const safeName =
    `${config.ticketNamePrefix}${i.user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "")
      .slice(0, 90) || "ticket";

  let channel;
  try {
    channel = await guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: ticketCategoryId || null,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: i.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        ...(staffRoleId
          ? [
              {
                id: staffRoleId,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                ],
              },
            ]
          : []),
      ],
    });
  } catch (err) {
    console.error("ticket create failed:", err);
    return i.reply({
      content:
        "Couldn't create a ticket. I need both **Manage Channels** and **Manage Roles** " +
        "permissions (Manage Roles is required to make the ticket private)" +
        (ticketCategoryId ? ", plus access to the ticket category" : "") +
        `.\n> Discord said: \`${err.message}\``,
      ephemeral: true,
    });
  }

  store.createTicket(channel.id, i.user.id, Date.now());

  const p = config.prefix;
  const welcome = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("🎟️ Ticket opened")
    .setDescription(config.ticketWelcome)
    .addFields({
      name: "📋 Commands",
      value: [
        `\`${p}ign <name>\` — set your in-game name`,
        `\`${p}ad\` — list the ads you can run`,
        `\`${p}rewards\` — view the level reward table`,
        `\`${p}balance\` — check your earnings`,
        `\`${p}withdraw\` — cash out (resets since-last-withdraw)`,
        `\`${p}close\` — close this ticket`,
        "",
        "📸 After running the ad in-game, post a screenshot of the **entire screen** here to earn.",
      ].join("\n"),
    });
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Close ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
  await channel.send({
    content: `<@${i.user.id}>`,
    embeds: [welcome],
    components: [closeRow],
  });

  return i.reply({
    content: `🎟️ Your ticket is ready: <#${channel.id}>`,
    ephemeral: true,
  });
}

// --- Close a ticket --------------------------------------------------------
async function closeTicketBtn(i) {
  const ticket = store.getOpenTicketByUser(i.user.id);
  const isOwner = ticket && ticket.channel_id === i.channel.id;
  const isStaff = i.member?.permissions.has(PermissionFlagsBits.ManageGuild);

  if (!store.isTicketChannel(i.channel.id)) {
    return i.reply({ content: "This isn't an open ticket.", ephemeral: true });
  }
  if (!isOwner && !isStaff) {
    return i.reply({
      content: "Only the ticket owner or staff can close this.",
      ephemeral: true,
    });
  }

  store.closeTicket(i.channel.id);
  await i.reply({ content: "🔒 Closing this ticket in 5 seconds…" });
  setTimeout(() => i.channel.delete().catch(() => {}), 5000);
}

// ===========================================================================
// Admin override commands (Manage Server, any channel)
// ===========================================================================
const ADMIN_COMMANDS = new Set([
  "addxp",
  "setxp",
  "addbalance",
  "give",
  "setbalance",
  "setlevel",
  "addads",
  "setads",
  "resetuser",
  "userinfo",
  "adminhelp",
  // ad management
  "addad",
  "removead",
  "togglead",
  "listads",
  // maintenance
  "clearcache",
]);

const money = (n) => `${config.currencySymbol}${n.toLocaleString()}`;

async function handleAdmin(msg, cmd, rest) {
  if (!msg.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return msg.reply("⛔ You need the **Manage Server** permission for that.");
  }

  if (cmd === "adminhelp") {
    return msg.reply(
      [
        "**User stats** (mention the target user):",
        `\`${config.prefix}addxp @user <n>\` — add (or subtract) XP`,
        `\`${config.prefix}setxp @user <n>\` — set XP exactly`,
        `\`${config.prefix}setlevel @user <lvl>\` — jump to a level`,
        `\`${config.prefix}addbalance @user <n>\` (alias \`give\`) — add cash`,
        `\`${config.prefix}setbalance @user <n>\` — set balance exactly`,
        `\`${config.prefix}addads @user <n>\` / \`setads @user <n>\` — ad count`,
        `\`${config.prefix}resetuser @user\` — wipe their stats`,
        `\`${config.prefix}userinfo @user\` — show their record`,
        "",
        "**Ad list:**",
        `\`${config.prefix}addad <full ad text>\` — add a running ad`,
        `\`${config.prefix}listads\` — show all ads (id + on/off)`,
        `\`${config.prefix}togglead <id>\` — turn an ad on/off`,
        `\`${config.prefix}removead <id>\` — delete an ad`,
        "",
        "**Maintenance:**",
        `\`${config.prefix}clearcache\` — clear the duplicate-screenshot cache (add \`@user\` for just one person)`,
      ].join("\n")
    );
  }

  // --- Maintenance (no target user) ----------------------------------------
  if (cmd === "clearcache") {
    const target = msg.mentions.users.first();
    if (target) {
      const n = store.clearUserHashes(target.id);
      return msg.reply(
        `🧹 Cleared **${n}** cached screenshot${n === 1 ? "" : "s"} for **${target.username}** — they can resubmit those now.`
      );
    }
    const n = store.clearHashes();
    return msg.reply(
      `🧹 Cleared the entire duplicate-screenshot cache (**${n}** hash${n === 1 ? "" : "es"}). Past screenshots will no longer be flagged as duplicates.`
    );
  }

  // --- Ad management (no target user) --------------------------------------
  if (cmd === "addad") {
    const text = rest.join(" ").trim();
    if (!text) {
      return msg.reply(
        `Usage: \`${config.prefix}addad <full ad text exactly as it appears in chat>\``
      );
    }
    const ad = store.addAd(text, msg.author.id);
    return msg.reply(`✅ Added ad **#${ad.id}** (active).`);
  }

  if (cmd === "listads") {
    const all = store.listAds(false);
    if (!all.length) return msg.reply("No ads yet. Add one with `!addad`.");
    const lines = all.map(
      (a) => `**#${a.id}** ${a.active ? "🟢" : "⚪️"} — ${a.text}`
    );
    return msg.reply(lines.join("\n").slice(0, 1900));
  }

  if (cmd === "togglead" || cmd === "removead") {
    const id = Number.parseInt(rest[0] ?? "", 10);
    if (Number.isNaN(id)) {
      return msg.reply(`Usage: \`${config.prefix}${cmd} <ad id>\``);
    }
    if (cmd === "removead") {
      const removed = store.removeAd(id);
      return msg.reply(
        removed ? `🗑️ Removed ad **#${id}**.` : `No ad with id ${id}.`
      );
    }
    // togglead: read current state, then flip it.
    const cur = store.listAds(false).find((a) => a.id === id);
    if (!cur) return msg.reply(`No ad with id ${id}.`);
    const flipped = store.setAdActive(id, !cur.active);
    return msg.reply(
      `${flipped.active ? "🟢 Enabled" : "⚪️ Disabled"} ad **#${id}**.`
    );
  }

  const target = msg.mentions.users.first();
  if (!target) {
    return msg.reply(
      `Mention a user. Example: \`${config.prefix}${cmd} @user 100\``
    );
  }

  // userinfo / resetuser don't need a number.
  if (cmd === "userinfo") {
    const u = store.getUser(target.id);
    return msg.reply(
      [
        `**${target.username}** — IGN: ${u.ign ?? "(none)"}`,
        `Level ${levelForXp(u.xp)} · XP ${u.xp} · Ads ${u.total_ads}`,
        `Balance ${money(u.balance)} · All-time ${money(u.all_time_total)}`,
        `Since withdraw — ads ${money(u.earned_ads)}, bonus ${money(
          u.earned_bonus
        )}`,
      ].join("\n")
    );
  }

  if (cmd === "resetuser") {
    store.resetUser(target.id);
    return msg.reply(`♻️ Reset **${target.username}** to a clean slate.`);
  }

  // Remaining commands need a numeric value (ignore the mention token).
  const numTok = rest.find((t) => /^-?\d+$/.test(t));
  const n = Number.parseInt(numTok ?? "", 10);
  if (Number.isNaN(n)) {
    return msg.reply(
      `Give a number. Example: \`${config.prefix}${cmd} @user 100\``
    );
  }

  const u = store.getUser(target.id);
  let updated;
  let summary;

  switch (cmd) {
    case "addxp":
      updated = store.adminSet(target.id, { xp: Math.max(0, u.xp + n) });
      summary = `XP ${n >= 0 ? "+" : ""}${n} → **${updated.xp}** (Level ${levelForXp(
        updated.xp
      )})`;
      break;
    case "setxp":
      updated = store.adminSet(target.id, { xp: Math.max(0, n) });
      summary = `XP set to **${updated.xp}** (Level ${levelForXp(updated.xp)})`;
      break;
    case "setlevel": {
      const row = LEVELS.find((l) => l.level === n);
      if (!row) {
        return msg.reply(
          `No such level. Valid range: 1–${LEVELS[LEVELS.length - 1].level}.`
        );
      }
      updated = store.adminSet(target.id, { xp: row.xp });
      summary = `Level set to **${n}** (XP ${row.xp})`;
      break;
    }
    case "addbalance":
    case "give":
      updated = store.adminSet(target.id, {
        balance: u.balance + n,
        all_time_total: u.all_time_total + Math.max(0, n),
      });
      summary = `Balance ${n >= 0 ? "+" : ""}${money(n)} → **${money(
        updated.balance
      )}**`;
      break;
    case "setbalance":
      updated = store.adminSet(target.id, { balance: n });
      summary = `Balance set to **${money(updated.balance)}**`;
      break;
    case "addads":
      updated = store.adminSet(target.id, {
        total_ads: Math.max(0, u.total_ads + n),
      });
      summary = `Ad count → **${updated.total_ads}**`;
      break;
    case "setads":
      updated = store.adminSet(target.id, { total_ads: Math.max(0, n) });
      summary = `Ad count set to **${updated.total_ads}**`;
      break;
  }

  // If XP/level changed, pay out any newly-reached level rewards.
  if (cmd === "addxp" || cmd === "setxp" || cmd === "setlevel") {
    const r = store.grantLevelRewards(target.id);
    if (r.levels.length) {
      summary += ` · 🎁 level rewards +${money(r.cash)} (Lvl ${r.levels.join(
        ", "
      )})`;
      const staffRoleId = gcfg(msg.guild.id, "staffRoleId");
      if (r.staff && staffRoleId) {
        const m = await msg.guild.members.fetch(target.id).catch(() => null);
        m?.roles.add(staffRoleId).catch(() => {});
      }
    }
  }

  return msg.reply(`✅ **${target.username}**: ${summary}`);
}

// ===========================================================================
// Command handling (inside a ticket)
// ===========================================================================
async function handleCommand(msg, cmd, rest) {
  const user = store.getUser(msg.author.id);

  if (cmd === "ign") {
    const ign = rest.join(" ").trim();
    if (!ign) {
      return msg.reply(
        `Please type \`${config.prefix}ign <your username>\`\nExample: \`${config.prefix}ign Olisaurus123\``
      );
    }
    store.setIgn(msg.author.id, ign);
    if (config.renameTicketOnIgn && msg.channel.manageable) {
      msg.channel
        .setName(ign.replace(/[^a-z0-9-_]/gi, "").slice(0, 90) || "ticket")
        .catch(() => {});
    }
    return msg.reply(
      `✅ Ticket bound to **${ign}**!\n` +
        `To get started, type \`${config.prefix}ad\` and copy-paste the command in-game, ` +
        `then send a screenshot of the **ENTIRE SCREEN** here or it won't count.`
    );
  }

  if (cmd === "ad") {
    const ads = store.listAds(true);
    if (!ads.length) return msg.reply({ embeds: [noAdsEmbed()] });
    return msg.reply({ embeds: [adsListEmbed(ads)] });
  }

  if (cmd === "rewards") {
    return msg.reply({ embeds: [rewardsEmbed(user)] });
  }

  if (cmd === "balance" || cmd === "bal") {
    return msg.reply(
      `📊 Balance: **${config.currencySymbol}${user.balance.toLocaleString()}** · ` +
        `All-time: ${config.currencySymbol}${user.all_time_total.toLocaleString()} · ` +
        `Ads: ${user.total_ads} · XP: ${user.xp}`
    );
  }

  if (cmd === "withdraw") {
    if (user.balance <= 0) return msg.reply("Nothing to withdraw.");
    if (!user.ign) {
      return msg.reply(
        `Set your in-game name first: \`${config.prefix}ign <your username>\``
      );
    }
    const amount = user.balance;
    const ign = user.ign;
    store.withdraw(msg.author.id);

    const payoutRoleId = gcfg(msg.guild.id, "payoutRoleId");
    const payoutChannelId = gcfg(msg.guild.id, "payoutChannelId");
    const ping = payoutRoleId ? `<@&${payoutRoleId}> ` : "";
    const payCmd = config.payoutCommandHint
      .replace("{ign}", ign)
      .replace("{amount}", String(amount));
    const request =
      `${ping}💸 **Payout request** — pay **${ign}** ${money(amount)} ` +
      `(requested by <@${msg.author.id}>)\n` +
      `Run ${config.payoutBotName}'s command:\n\`${payCmd}\``;
    const allowedMentions = {
      roles: payoutRoleId ? [payoutRoleId] : [],
      users: [msg.author.id],
    };

    const dest = payoutChannelId
      ? await client.channels.fetch(payoutChannelId).catch(() => null)
      : null;
    if (dest?.send) {
      await dest.send({ content: request, allowedMentions });
    } else {
      await msg.channel.send({ content: request, allowedMentions });
    }

    return msg.reply(
      `✅ Requested a payout of ${money(amount)} — staff have been pinged to pay **${ign}** in-game.`
    );
  }

  if (cmd === "close") {
    const ticket = store.getOpenTicketByUser(msg.author.id);
    const isOwner = ticket && ticket.channel_id === msg.channel.id;
    const isStaff = msg.member?.permissions.has(
      PermissionFlagsBits.ManageGuild
    );
    if (!isOwner && !isStaff) {
      return msg.reply("Only the ticket owner or staff can close this.");
    }
    store.closeTicket(msg.channel.id);
    await msg.reply("🔒 Closing this ticket in 5 seconds…");
    setTimeout(() => msg.channel.delete().catch(() => {}), 5000);
    return;
  }

  if (cmd === "help") {
    return msg.reply(
      [
        `\`${config.prefix}ign <name>\` — bind your in-game name`,
        `\`${config.prefix}ad\` — list the ads you can run`,
        `\`${config.prefix}rewards\` — view the level reward table`,
        `\`${config.prefix}balance\` — your earnings`,
        `\`${config.prefix}withdraw\` — cash out (resets since-last-withdraw)`,
        `\`${config.prefix}close\` — close this ticket`,
      ].join("\n")
    );
  }
}

// ===========================================================================
// Ad submission handling (inside a ticket)
// ===========================================================================
async function handleSubmission(msg, att) {
  const user = store.getUser(msg.author.id);

  if (!user.ign) {
    return msg.reply(
      `Set your in-game name first: \`${config.prefix}ign <your username>\``
    );
  }

  const now = Date.now();
  const elapsed = now - user.last_ad_at;
  if (user.last_ad_at && elapsed < config.cooldownMs) {
    return msg.reply({ embeds: [cooldownEmbed(config.cooldownMs - elapsed)] });
  }

  let buffer;
  try {
    const res = await fetch(att.url);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch {
    return msg.reply("Couldn't download that image — try re-uploading.");
  }

  // 1) Full-screen check (resolution + aspect ratio).
  const meta = await imageMeta(buffer);
  const fs = checkFullScreen(meta, config);
  if (!fs.ok) {
    return msg.reply({ embeds: [notFullScreenEmbed(fs.reason)] });
  }

  // 2) Duplicate check.
  const hash = await dhash(buffer);
  const dup = findDuplicate(hash, store.allHashes(), config.dupeHammingThreshold);
  if (dup) {
    const flagLogChannelId = gcfg(msg.guild.id, "flagLogChannelId");
    if (flagLogChannelId) {
      const ch = await client.channels
        .fetch(flagLogChannelId)
        .catch(() => null);
      ch?.send?.(
        `🚩 <@${msg.author.id}> (${user.ign}) submitted a duplicate ` +
          `(dist ${dup.distance}, original by <@${dup.discord_id}>).`
      );
    }
    return msg.reply({ embeds: [flaggedEmbed(dup)] });
  }

  // 3) OCR: read the screenshot and fuzzy-match it against the running ads.
  const activeAds = store.listAds(true);
  if (!activeAds.length) {
    return msg.reply({ embeds: [noAdsEmbed()] });
  }
  await msg.channel.sendTyping().catch(() => {});
  let text;
  try {
    text = await ocrText(buffer);
  } catch (err) {
    console.error("OCR failed:", err);
    return msg.reply({ embeds: [unreadableEmbed()] });
  }
  const match = bestAdMatch(text, activeAds, {
    minWordLen: config.adWordMinLen,
    threshold: config.adMatchThreshold,
  });
  if (!match) {
    return msg.reply({ embeds: [adNotFoundEmbed()] });
  }
  if (config.requireIgnInScreenshot && !ignPresent(text, user.ign)) {
    return msg.reply({ embeds: [ignMissingEmbed()] });
  }
  console.log(
    `Ad #${match.ad.id} matched for ${user.ign} ` +
      `(${match.matched}/${match.total} words, ${(match.score * 100).toFixed(0)}%)`
  );

  store.saveHash(msg.author.id, hash, msg.id, now);
  const prevLevel = levelForXp(user.xp);
  store.recordAdReward({
    discordId: msg.author.id,
    xpGain: config.xpPerAd,
    adCash: config.cashPerAd,
    now,
  });
  // Pay out any level-up rewards now reached.
  const reward = store.grantLevelRewards(msg.author.id);
  const updated = store.getUser(msg.author.id);

  const staffRoleId = gcfg(msg.guild.id, "staffRoleId");
  if (reward.staff && staffRoleId) {
    msg.member?.roles.add(staffRoleId).catch(() => {});
  }

  const result = {
    prevLevel,
    newLevel: reward.newLevel,
    leveledUp: reward.newLevel > prevLevel,
    bonusCash: reward.cash,
    grantedStaffRole: reward.staff,
  };

  await msg.reply({
    embeds: [
      adEmbed(updated, result, {
        xpGain: config.xpPerAd,
        adCash: config.cashPerAd,
        bonusCash: reward.cash,
      }),
    ],
  });

  if (config.remindWhenCooldownEnds) {
    setTimeout(() => {
      msg.channel
        .send(`⏰ <@${msg.author.id}> 10 minutes is up, time to post your next ad!`)
        .catch(() => {});
    }, config.cooldownMs);
  }
}

client.login(DISCORD_TOKEN);
