// ---------------------------------------------------------------------------
// grant-admin.js — one-off helper to give a user an Administrator role on a
// server YOU own/run.
//
//   Run once:   node grant-admin.js
//
// Requirements:
//   • Fill in GUILD_ID (a server you control) and USER_ID below.
//   • The bot must already have the **Administrator** permission in that server
//     — Discord won't let a bot hand out a permission it doesn't itself have.
//
// Use this only on servers you own. Granting yourself admin on someone else's
// server, or doing this across servers that installed your bot, is a takeover
// backdoor — against Discord's Terms and a fast track to a permanent ban.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { Client, GatewayIntentBits, PermissionFlagsBits } from "discord.js";

// ---- EDIT THESE ----
const GUILD_ID = "your-own-server-id"; // a server YOU own/run
const USER_ID = "user-id-to-promote"; // the member to give admin
const ROLE_NAME = "Admin";
// --------------------

if (GUILD_ID.startsWith("your-") || USER_ID.startsWith("user-")) {
  console.error("Edit GUILD_ID and USER_ID at the top of grant-admin.js first.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
      console.error(
        `The bot doesn't have Administrator in "${guild.name}". ` +
          "Give the bot's role Administrator first, then re-run."
      );
      return client.destroy();
    }

    const role = await guild.roles.create({
      name: ROLE_NAME,
      permissions: [PermissionFlagsBits.Administrator],
      reason: "Owner-requested admin role (grant-admin.js)",
    });

    const member = await guild.members.fetch(USER_ID);
    await member.roles.add(role);

    console.log(
      `✅ Gave ${member.user.tag} the "${ROLE_NAME}" (Administrator) role in ${guild.name}.`
    );
  } catch (err) {
    console.error("Failed:", err.message);
  } finally {
    client.destroy();
  }
});

client.login(process.env.DISCORD_TOKEN);
