// ---------------------------------------------------------------------------
// setup.js — first-run provisioning. The first time the bot is in a server
// (joined, or seen at startup) and that server isn't configured yet, this
// creates the roles, ticket category, payout channel, flag-log channel, and an
// advertising panel, then saves their IDs into the per-guild config in the DB.
//
// This means no manual ID-copying into .env — important on a host like Railway
// where editing files at runtime isn't practical. Anything it can't create
// (missing permissions) is simply skipped and can be set later via .env.
// ---------------------------------------------------------------------------
import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import * as store from "./db.js";
import { config } from "./config.js";

const V = PermissionFlagsBits.ViewChannel;
const S = PermissionFlagsBits.SendMessages;
const R = PermissionFlagsBits.ReadMessageHistory;

// Provision a guild if it hasn't been set up. Safe to call repeatedly — it
// no-ops once `configured` is set.
export async function ensureGuildSetup(guild, client) {
  const existing = store.getGuildConfig(guild.id);
  if (existing.configured) return existing;

  console.log(`First-time setup for "${guild.name}" (${guild.id})…`);
  const cfg = {};
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    // Couldn't resolve our own member yet — don't mark configured; retry later.
    console.warn("setup: couldn't resolve bot member; will retry.");
    return existing;
  }

  const canRoles = me.permissions.has(PermissionFlagsBits.ManageRoles);
  const canChannels = me.permissions.has(PermissionFlagsBits.ManageChannels);

  // --- Roles ---------------------------------------------------------------
  if (canRoles) {
    cfg.staffRoleId = await mk(() =>
      guild.roles.create({
        name: "Ad Staff",
        color: 0xf1c40f,
        reason: "Ad bot setup",
      })
    );
    cfg.payoutRoleId = await mk(() =>
      guild.roles.create({
        name: "Payer",
        color: 0x2ecc71,
        mentionable: true,
        reason: "Ad bot setup",
      })
    );
  }

  // --- Channels ------------------------------------------------------------
  if (canChannels) {
    cfg.ticketCategoryId = await mk(() =>
      guild.channels.create({
        name: "Tickets",
        type: ChannelType.GuildCategory,
      })
    );

    const staffOnly = [
      { id: guild.roles.everyone.id, deny: [V] },
      { id: client.user.id, allow: [V, S, R] },
      ...(cfg.staffRoleId ? [{ id: cfg.staffRoleId, allow: [V, S, R] }] : []),
    ];

    cfg.payoutChannelId = await mk(() =>
      guild.channels.create({
        name: "payout-requests",
        type: ChannelType.GuildText,
        permissionOverwrites: cfg.payoutRoleId
          ? [...staffOnly, { id: cfg.payoutRoleId, allow: [V, S, R] }]
          : staffOnly,
      })
    );

    cfg.flagLogChannelId = await mk(() =>
      guild.channels.create({
        name: "flagged-submissions",
        type: ChannelType.GuildText,
        permissionOverwrites: staffOnly,
      })
    );

    // Public channel with the "open a ticket" panel.
    const panelChannelId = await mk(() =>
      guild.channels.create({
        name: "advertise-here",
        type: ChannelType.GuildText,
      })
    );
    if (panelChannelId) {
      const ch = await guild.channels.fetch(panelChannelId).catch(() => null);
      if (ch) await postPanel(ch);
      cfg.panelChannelId = panelChannelId;
    }
  }

  cfg.configured = true;
  cfg.setupAt = Date.now();
  store.setGuildConfig(guild.id, cfg);

  await notifyOwner(guild, cfg).catch(() => {});
  console.log(`Setup complete for "${guild.name}".`);
  return store.getGuildConfig(guild.id);
}

// Post the advertising panel (same embed/button as the !setup command).
export async function postPanel(channel) {
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
  return channel.send({ embeds: [embed], components: [row] });
}

// Run a create() call, return the new object's id or null on failure.
async function mk(fn) {
  try {
    const obj = await fn();
    return obj.id;
  } catch (err) {
    console.warn("setup: skipped a resource —", err.message);
    return null;
  }
}

async function notifyOwner(guild, cfg) {
  const owner = await guild.fetchOwner().catch(() => null);
  if (!owner) return;
  const line = (label, id, type) =>
    id ? `• ${label}: ${type === "ch" ? `<#${id}>` : `<@&${id}>`}` : `• ${label}: ⚠️ not created (missing permission)`;
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`✅ Ad bot set up in ${guild.name}`)
    .setDescription(
      [
        "I created everything I need:",
        line("Staff role", cfg.staffRoleId),
        line("Payout ping role", cfg.payoutRoleId),
        line("Payout channel", cfg.payoutChannelId, "ch"),
        line("Flag log", cfg.flagLogChannelId, "ch"),
        line("Ticket panel", cfg.panelChannelId, "ch"),
        "",
        "**Next step:** add the ads people can run with " +
          "`!addad <full ad text>`, then `!listads` to check them. " +
          "Run `!adminhelp` for everything else.",
      ].join("\n")
    );
  await owner.send({ embeds: [embed] });
}
