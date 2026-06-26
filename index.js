// ---------------------------------------------------------------------------
// index.js — the bot. Ticket panel + private ticket channels, ! commands and
// ad-screenshot submissions (size + duplicate verified), XP/cash economy.
// All commands and submissions ONLY work inside ticket channels.
// ---------------------------------------------------------------------------
import "dotenv/config";
import http from "node:http";
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
  payoutEnabled,
  payPlayer,
  initPayout,
  whoAmI,
  listFirmAccounts,
} from "./payout.js";
import {
  adEmbed,
  rewardsEmbed,
  flaggedEmbed,
  notFullScreenEmbed,
  adNotFoundEmbed,
  ignMissingEmbed,
  unreadableEmbed,
  busyEmbed,
  adsListEmbed,
  adFullEmbed,
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

// --- TEMPORARY connection diagnostics (remove once it's logging in) ---------
client.on("debug", (m) => console.log("[debug]", m));
client.on("warn", (m) => console.warn("[warn]", m));
client.on("error", (e) => console.error("[client error]", e));
client.on("shardError", (e) => console.error("[shard error]", e));
setTimeout(() => {
  if (!client.isReady()) {
    console.error(
      "⚠️ Still not ready after 30s — the gateway isn't completing the handshake."
    );
  }
}, 30000);
// ----------------------------------------------------------------------------

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const isImage = (att) =>
  (att.contentType && att.contentType.startsWith("image/")) ||
  IMAGE_RE.test(att.name ?? "") ||
  IMAGE_RE.test(att.url.split("?")[0]);

// Concurrency limiter: run at most `concurrency` heavy jobs at once, queue the
// rest up to `maxQueue`, and reject beyond that (so memory stays bounded).
function createLimiter(concurrency, maxQueue) {
  let active = 0;
  const q = [];
  const runNext = () => {
    if (active >= concurrency || q.length === 0) return;
    active++;
    q.shift()();
  };
  return {
    pending: () => q.length,
    async run(fn) {
      if (q.length >= maxQueue) throw new Error("QUEUE_FULL");
      await new Promise((res) => {
        q.push(res);
        runNext();
      });
      try {
        return await fn();
      } finally {
        active--;
        runNext();
      }
    },
  };
}
const ocrLimiter = createLimiter(config.ocrConcurrency, config.ocrMaxQueue);

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
  console.log(`🍄 Gnomeads is gnoming — logged in as ${c.user.tag}`);
  initPayout();
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
      .setLabel("Dig a burrow")
      .setEmoji("🍄")
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
        content: `You've already got a burrow dug: <#${existing.channel_id}>`,
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
    .setTitle("🍄 Your burrow is dug!")
    .setDescription(config.ticketWelcome)
    .addFields({
      name: "📋 Gnome commands",
      value: [
        `\`${p}ign <name>\` — plant your in-game gname`,
        `\`${p}ad\` — see the ads worth gnoming`,
        `\`${p}rewards\` — view the gnome rank rewards`,
        `\`${p}balance\` — peek in your burrow`,
        `\`${p}withdraw\` — dig out your earnings`,
        `\`${p}close\` — fill in this burrow`,
        "",
        "📸 After running an ad in-game, drop a screenshot of the **entire screen** here to earn. Gnice!",
      ].join("\n"),
    });
  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket_close")
      .setLabel("Fill in burrow")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Danger)
  );
  await channel.send({
    content: `<@${i.user.id}>`,
    embeds: [welcome],
    components: [closeRow],
  });

  return i.reply({
    content: `🍄 Your burrow is ready: <#${channel.id}>`,
    ephemeral: true,
  });
}

// --- Close a ticket --------------------------------------------------------
async function closeTicketBtn(i) {
  const ticket = store.getOpenTicketByUser(i.user.id);
  const isOwner = ticket && ticket.channel_id === i.channel.id;
  const isStaff = i.member?.permissions.has(PermissionFlagsBits.ManageGuild);

  if (!store.isTicketChannel(i.channel.id)) {
    return i.reply({ content: "This isn't an open burrow.", ephemeral: true });
  }
  if (!isOwner && !isStaff) {
    return i.reply({
      content: "Only the burrow's owner or staff can fill it in, gnome.",
      ephemeral: true,
    });
  }

  store.closeTicket(i.channel.id);
  await i.reply({ content: "🔒 Filling in this burrow in 5 seconds… take it gnome!" });
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
  "setcap",
  "refill",
  // maintenance
  "clearcache",
  "payoutinfo",
  "resetup",
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
        `\`${config.prefix}setcap <id> <total runs>\` — paid run limit (0 = unlimited)`,
        `\`${config.prefix}refill <id>\` — reset an ad's used-run count to 0`,
        `\`${config.prefix}listads\` — show all ads (id, on/off, runs used)`,
        `\`${config.prefix}togglead <id>\` — turn an ad on/off`,
        `\`${config.prefix}removead <id>\` — delete an ad`,
        "",
        "**Maintenance:**",
        `\`${config.prefix}clearcache\` — clear the duplicate-screenshot cache (add \`@user\` for just one person)`,
        `\`${config.prefix}payoutinfo\` — show your DC token scope + the account ids you can pay from`,
        `\`${config.prefix}resetup\` — re-run first-time setup (recreates roles/channels)`,
      ].join("\n")
    );
  }

  // --- Maintenance (no target user) ----------------------------------------
  if (cmd === "resetup") {
    store.setGuildConfig(msg.guild.id, { configured: false });
    await msg.reply("🔧 Re-running first-time setup…");
    await ensureGuildSetup(msg.guild, client);
    return msg.reply(
      "✅ Setup re-run. New roles/channels were created and saved. " +
        "Old ones aren't deleted — remove any duplicates you don't want."
    );
  }

  if (cmd === "payoutinfo") {
    if (!payoutEnabled()) {
      return msg.reply(
        "No DC API token is set. Add `DC_API_TOKEN` to `.env` (issue one in-game with `/treasuryapi business issue`)."
      );
    }
    const me = await whoAmI();
    if (!me.ok) {
      return msg.reply(
        `Couldn't read the token: \`${me.error}\`${me.message ? ` — ${me.message}` : ""}. It may be expired — re-issue with \`/treasuryapi … issue\`.`
      );
    }
    const lines = [
      `🔑 Token scope: **${me.data.keyType}**` +
        (me.data.firmId ? ` · firm #${me.data.firmId}` : "") +
        (me.data.accountId ? ` · personal acct #${me.data.accountId}` : ""),
    ];
    if (me.data.keyType === "BUSINESS") {
      const acc = await listFirmAccounts();
      if (acc.ok && Array.isArray(acc.data)) {
        lines.push("Pay **from** one of these — set its id as `DC_FROM_ACCOUNT_ID`:");
        for (const a of acc.data) {
          lines.push(
            `• \`${a.accountId}\` — ${a.displayName || a.accountType} — bal ${config.currencySymbol}${a.balance}`
          );
        }
      } else {
        lines.push(`(couldn't list firm accounts: \`${acc.error || ""}\`)`);
      }
    } else {
      lines.push(
        "Personal token → leave `DC_FROM_ACCOUNT_ID` **blank**; payouts come from your personal account."
      );
    }
    return msg.reply(lines.join("\n").slice(0, 1900));
  }

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
    return msg.reply(
      `✅ Added ad **#${ad.id}** (active, unlimited runs). ` +
        `Set a paid limit with \`${config.prefix}setcap ${ad.id} <total runs>\`.`
    );
  }

  if (cmd === "setcap") {
    const id = Number.parseInt(rest[0] ?? "", 10);
    const cap = Number.parseInt(rest[1] ?? "", 10);
    if (Number.isNaN(id) || Number.isNaN(cap)) {
      return msg.reply(
        `Usage: \`${config.prefix}setcap <ad id> <total runs>\` (use 0 for unlimited).`
      );
    }
    const ad = store.setAdCap(id, cap);
    if (!ad) return msg.reply(`No ad with id ${id}.`);
    return msg.reply(
      cap > 0
        ? `✅ Ad **#${id}** is capped at **${cap}** total runs (${ad.runs || 0} used, ${Math.max(0, cap - (ad.runs || 0))} left).`
        : `✅ Ad **#${id}** is now **unlimited**.`
    );
  }

  if (cmd === "refill") {
    const id = Number.parseInt(rest[0] ?? "", 10);
    if (Number.isNaN(id)) {
      return msg.reply(`Usage: \`${config.prefix}refill <ad id>\``);
    }
    const ad = store.refillAd(id);
    if (!ad) return msg.reply(`No ad with id ${id}.`);
    return msg.reply(
      `✅ Reset ad **#${id}**'s run count to 0 — ${ad.cap > 0 ? `**${ad.cap}** runs available again` : "it's unlimited anyway"}.`
    );
  }

  if (cmd === "listads") {
    const all = store.listAds(false);
    if (!all.length) return msg.reply("No ads yet. Add one with `!addad`.");
    const lines = all.map((a) => {
      const cap = a.cap > 0 ? ` · ${a.runs || 0}/${a.cap} runs` : " · ∞";
      return `**#${a.id}** ${a.active ? "🟢" : "⚪️"}${cap} — ${a.text}`;
    });
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
      `✅ Rooted in as **${ign}**! Gnice to meet you.\n` +
        `To get gnoming, type \`${config.prefix}ad\`, run one in-game, ` +
        `then send a screenshot of the **ENTIRE SCREEN** here or it won't count.`
    );
  }

  if (cmd === "ad") {
    const ads = store.listAds(true).filter(store.adHasQuota);
    if (!ads.length) return msg.reply({ embeds: [noAdsEmbed()] });
    return msg.reply({ embeds: [adsListEmbed(ads)] });
  }

  if (cmd === "rewards") {
    return msg.reply({ embeds: [rewardsEmbed(user)] });
  }

  if (cmd === "balance" || cmd === "bal") {
    // Admins (Manage Server) can check another user by mentioning them.
    const mentioned = msg.mentions.users.first();
    const isStaff = msg.member?.permissions.has(PermissionFlagsBits.ManageGuild);
    const target = mentioned && isStaff ? store.getUser(mentioned.id) : user;
    const who = mentioned && isStaff ? `**${mentioned.username}** — ` : "";
    if (mentioned && !isStaff) {
      return msg.reply("You can only peek in your own burrow, gnome.");
    }
    return msg.reply(
      `📊 ${who}Burrow: **${config.currencySymbol}${target.balance.toLocaleString()}** · ` +
        `All-time: ${config.currencySymbol}${target.all_time_total.toLocaleString()} · ` +
        `Ads gnomed: ${target.total_ads} · XP: ${target.xp}`
    );
  }

  if (cmd === "withdraw") {
    if (user.balance <= 0) return msg.reply("Your burrow's empty — gnothing to withdraw yet!");
    if (!user.ign) {
      return msg.reply(
        `Plant your gname first: \`${config.prefix}ign <your username>\``
      );
    }
    const amount = user.balance;
    const ign = user.ign;

    // Auto-pay via the DC Treasury API if a token is configured.
    if (payoutEnabled()) {
      await msg.channel.sendTyping().catch(() => {});
      const memo = config.payoutMemo.replace("{ign}", ign);
      const result = await payPlayer(ign, amount, memo);
      if (result.ok) {
        store.withdraw(msg.author.id); // only debit on confirmed success
        return msg.reply(
          `✅ Sent **${money(amount)}** straight to **${ign}** in-game — gnice doing business! ` +
            (result.txnId ? `(txn #${result.txnId})` : "")
        );
      }
      // Failure: leave the balance intact so nothing is lost.
      console.error("payout failed:", result);
      return msg.reply(
        `⚠️ Payout hit a snag: \`${result.error}\`${
          result.message ? ` — ${result.message}` : ""
        }.\nYour balance is **unchanged**. Give it another go shortly or poke staff.`
      );
    }

    // No API token → fall back to pinging staff with the command to run.
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
      `✅ Payout of ${money(amount)} requested — the gnomes have pinged staff to pay **${ign}** in-game.`
    );
  }

  if (cmd === "close") {
    const ticket = store.getOpenTicketByUser(msg.author.id);
    const isOwner = ticket && ticket.channel_id === msg.channel.id;
    const isStaff = msg.member?.permissions.has(
      PermissionFlagsBits.ManageGuild
    );
    if (!isOwner && !isStaff) {
      return msg.reply("Only the burrow's owner or staff can fill this one in, gnome.");
    }
    store.closeTicket(msg.channel.id);
    await msg.reply("🔒 Filling in this burrow in 5 seconds… take it gnome!");
    setTimeout(() => msg.channel.delete().catch(() => {}), 5000);
    return;
  }

  if (cmd === "help") {
    return msg.reply(
      [
        "🍄 **Gnomeads — here's the dig:**",
        `\`${config.prefix}ign <name>\` — plant your in-game gname`,
        `\`${config.prefix}ad\` — see the ads worth gnoming`,
        `\`${config.prefix}rewards\` — view the gnome rank rewards`,
        `\`${config.prefix}balance\` — peek in your burrow`,
        `\`${config.prefix}withdraw\` — dig out your earnings`,
        `\`${config.prefix}close\` — fill in this burrow`,
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
      `Plant your gname first: \`${config.prefix}ign <your username>\``
    );
  }

  const now = Date.now();
  // Short anti-spam gap between submissions (config.cooldownMs, 0 = off).
  const elapsed = now - user.last_ad_at;
  if (config.cooldownMs > 0 && user.last_ad_at && elapsed < config.cooldownMs) {
    return msg.reply({ embeds: [cooldownEmbed(config.cooldownMs - elapsed)] });
  }

  // Route the heavy work (image download + OCR) through a concurrency limiter
  // so a burst of submissions can't exhaust memory and OOM-crash a small host.
  try {
    await ocrLimiter.run(() => processSubmission(msg, att, user, now));
  } catch (err) {
    if (err.message === "QUEUE_FULL") {
      return msg.reply({ embeds: [busyEmbed()] });
    }
    console.error("submission error:", err);
  }
}

// The heavy part: download, verify (full-screen → duplicate → OCR), reward.
async function processSubmission(msg, att, user, now) {
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
  // Daily cap: if this ad has run out its paid quota for today, don't count it.
  if (!store.adHasQuota(match.ad)) {
    return msg.reply({ embeds: [adFullEmbed()] });
  }
  console.log(
    `Ad #${match.ad.id} matched for ${user.ign} ` +
      `(${match.matched}/${match.total} words, ${(match.score * 100).toFixed(0)}%)`
  );

  store.saveHash(msg.author.id, hash, msg.id, now);
  store.recordAdRun(match.ad.id); // count this run against the ad's cap
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
}

// Optional health endpoint. Some hosts (incl. panel-based ones like HeavenCloud)
// allocate a port and expect something listening, and uptime monitors can ping
// it. Binds only if a port is provided.
const HEALTH_PORT = process.env.PORT || process.env.SERVER_PORT;
if (HEALTH_PORT) {
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    })
    .listen(HEALTH_PORT, () =>
      console.log(`Health server listening on :${HEALTH_PORT}`)
    );
}

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("❌ Discord login failed:", err);
  process.exit(1);
});
