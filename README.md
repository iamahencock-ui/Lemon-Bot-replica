# Ad-Reward Bot (Lemonade clone)

A Discord bot that pays Minecraft players for posting in-game ads. Players bind
their IGN, grab a copy-paste `/ad` command, run it in-game, and submit a
full-screen screenshot. The bot verifies the screenshot (size + perceptual
duplicate check), then awards XP and in-game currency on a leveling curve with
milestone bonuses — a faithful clone of the Lemonade bot's mechanics.

## The loop

```
!ign <name>   →   !ad   →   run /ad in-game   →   post full-screen screenshot
                                                      │
                                       verify size + dedupe (dHash)
                                                      │
                                   +7 XP, +$50, level-up bonuses → embed
                                                      │
                                        10-min cooldown → reminder ping
```

## Setup

1. **Create the bot** at <https://discord.com/developers/applications> → New
   Application → Bot. Under **Privileged Gateway Intents**, enable
   **MESSAGE CONTENT INTENT** (required — the bot reads `!` commands and
   screenshots). Copy the token.
2. **Invite it** with the `bot` scope and permissions: Read/Send Messages,
   Attach Files, Embed Links, Manage Channels (for ticket renaming), Manage
   Roles (only if you use the staff-level reward).
3. **Install & configure:**
   ```bash
   npm install
   cp .env.example .env      # then fill in DISCORD_TOKEN etc.
   npm test                  # verify level math + hashing
   npm start
   ```

Node 18+ required (uses global `fetch`).

## Auto-payout (DemocracyCraft Treasury API)

`!withdraw` can pay advertisers **automatically in-game** using DemocracyCraft's
Treasury REST API (`POST /api/v1/transfers/to-player`). To enable it:

1. **Issue an API token in-game.** Run `/treasuryapi business issue` (recommended
   for a firm) or `/treasuryapi personal issue`. Copy the JWT it gives you.
2. **Find the source account id** the payouts come from. For a firm token, call
   `GET /economy/api/v1/firms/me/accounts` with the token (or check in-game) and
   note the `accountId` of the account that holds your payout funds.
3. **Add to `.env`:**
   ```
   DC_API_TOKEN=<the JWT>
   DC_FROM_ACCOUNT_ID=<the firm account id>      # omit for a personal token
   # DC_API_BASE=https://api.democracycraft.net/economy   # default, rarely changed
   ```

With a token set, `!withdraw` debits that account, pays the player by username,
and only clears their balance on a confirmed success (failures leave the balance
untouched). Each transfer uses an idempotency key, so retries never double-pay.
The token is **auto-rotated** before it expires and the new one is saved to
`adbot.json` — so keep that on a persistent volume (see Railway notes). If the
token is missing/expired, `!withdraw` falls back to pinging staff with the
command to run.

## First-run auto-setup

The first time the bot lands in a server (when it's added, or at startup if it's
already there), `setup.js` provisions everything automatically and saves the IDs
into the per-guild config — no manual ID-copying needed:

- an **Ad Staff** role and a mentionable **Payer** role,
- a **Tickets** category,
- a private **payout-requests** channel and **flagged-submissions** log,
- a public **advertise-here** channel with the "Open a ticket" panel already posted.

It then DMs the server owner a summary. Anything it lacks permission to create is
skipped and can be supplied via `.env` instead (see below). Per-guild config
always takes precedence over `.env`, so the bot works across multiple servers.

## Deploying to Railway

The bot is a long-running process, so it needs an always-on host. On
[railway.app](https://railway.app):

1. Push this folder to a **GitHub repo** (don't commit `.env` or `node_modules`
   — the included `.gitignore` handles that).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo. Railway
   auto-detects Node, runs `npm install`, then `npm start`.
3. **Variables** tab → add `DISCORD_TOKEN` (and `DATA_DIR=/data`). Thanks to
   auto-setup you don't need the role/channel IDs.
4. **Persistent data (important):** Railway's disk is wiped on every redeploy, so
   add a **Volume** and mount it at **`/data`**. The bot writes `adbot.json`
   there (via `DATA_DIR`), so balances, ads, and the dedupe cache survive
   restarts. Without this, all data resets on each deploy.
5. Invite the bot to your server (OAuth2 URL with `bot` scope + Manage Channels,
   Manage Roles, Send Messages, Embed Links, Attach Files). It sets itself up on
   join.

Node 18+ is required; Railway uses a current Node by default.

## Deploying to HeavenCloud (or similar panel hosts)

HeavenCloud is a free, always-on, panel-based (Pterodactyl) host with ~715 MB
RAM. The bot is tuned to fit:

- **OCR is queued** — at most `ocrConcurrency` (default 1) screenshot runs at a
  time, the rest wait up to `ocrMaxQueue`, and beyond that submitters are told
  it's busy. This keeps memory bounded so a burst of submissions can't OOM the
  container. `sharp` is also capped to one thread with caching off.
- **OCR language data is cached** under `DATA_DIR/.tesseract-cache` so it's
  downloaded once, not on every restart.

Steps:

1. Create a **Node.js** server/egg on the panel and pick **Node 18+**.
2. Upload the project (zip it without `node_modules`, or point it at a Git repo).
3. Set the **startup command** to `npm start` (the panel runs `npm install`
   first).
4. In the panel's **Variables/Environment**, add `DISCORD_TOKEN`, your
   `DC_API_TOKEN` + `DC_FROM_ACCOUNT_ID` for payouts, and set `DATA_DIR` to a
   path inside the persistent volume (the panel's file area persists across
   restarts, so the default also works).
5. Start it. If the panel assigns a port, the bot auto-binds a tiny health
   endpoint on `PORT`/`SERVER_PORT` (returns `ok`), which also lets an uptime
   monitor ping it.

Capacity note: on ~715 MB, run OCR **one at a time** (the default). Throughput is
roughly 15–30 screenshots/minute; a big backlog just queues and clears in order.
If `npm install` fails on `sharp`, the container is likely musl/Alpine — pick a
Debian/Ubuntu-based Node egg instead.

## Configuration

Everything tunable lives in **`config.js`**:

- `xpPerAd` (7), `cashPerAd` (50), `cooldownMs` (10 min)
- `adCommand` — **change this to your own shop's ad text**
- `dupeHammingThreshold` (5) — how aggressively to flag duplicate screenshots
- `minImageWidth/Height` — rejects low-effort crops (enforces "entire screen")
- `LEVELS[]` — the full XP-threshold + reward table (matches Lemonade's L1–21;
  extend it to add more levels)

`.env` holds secrets and IDs: `DISCORD_TOKEN`, `GUILD_ID`, optional
`STAFF_ROLE_ID`, `FLAG_LOG_CHANNEL_ID`, `PAYOUT_ROLE_ID`, `PAYOUT_CHANNEL_ID`
(fallback ping target if auto-payout is off), and for auto-payout
`DC_API_TOKEN` + `DC_FROM_ACCOUNT_ID` (see the Auto-payout section). All role/
channel IDs are optional thanks to first-run auto-setup.

## Commands

| Command | Where | Effect |
|---|---|---|
| `!setup` | any channel (admin) | Posts the ticket panel with an "Open a ticket" button |
| `!ign <name>` | in a ticket | Bind in-game name; renames the ticket channel |
| `!ad` | in a ticket | Lists the currently running ads to copy and run in-game |
| `!rewards` | in a ticket | Shows the level reward table + "you are here" |
| `!balance` | in a ticket | Your balance, all-time total, ads, XP |
| `!withdraw` | in a ticket | **Auto-pays** the player in-game via the DC Treasury API (or, if no API token is set, pings staff with the command to run), then resets the balance |
| `!close` | in a ticket | Close the ticket (owner or staff) |
| `!help` | in a ticket | Lists commands |

**Tickets:** an admin runs `!setup` once to post the panel. Members click
**Open a ticket** → the bot creates a private channel (visible only to them and
staff) with a **Close ticket** button. Every command and screenshot submission
**only works inside a ticket channel** — they're ignored anywhere else.

Posting an **image attachment** in a ticket (with an IGN set, off cooldown)
counts as an ad submission.

### Admin commands

Require the **Manage Server** permission and work in any channel. Mention the
target user. Run `!adminhelp` in Discord for the live list.

| Command | Effect |
|---|---|
| `!addxp @user <n>` | Add (or subtract, with a negative) XP |
| `!setxp @user <n>` | Set XP exactly |
| `!setlevel @user <lvl>` | Jump the user to a level |
| `!addbalance @user <n>` (alias `!give`) | Add cash |
| `!setbalance @user <n>` | Set balance exactly |
| `!addads @user <n>` / `!setads @user <n>` | Adjust ad count |
| `!resetuser @user` | Wipe their stats |
| `!userinfo @user` | Show their full record |
| `!addad <full ad text>` | Add an ad to the running list |
| `!listads` | List all ads with id + on/off state |
| `!togglead <id>` | Turn an ad on or off |
| `!removead <id>` | Delete an ad |
| `!clearcache` | Clear the duplicate-screenshot cache (add `@user` to clear just one person) |

Level is derived from XP, so `!setlevel` simply sets XP to that level's threshold.

Optional `.env` setting `TICKET_CATEGORY_ID` puts new tickets under a specific
category (folder). Leave it blank to create them at the top level.

## How verification works

Every submission passes three gates before it earns anything:

1. **Full-screen check** — resolution (`minImageWidth/Height`) plus aspect ratio
   (`minAspect`–`maxAspect`). A cropped chat box is too small or the wrong shape
   and gets rejected; only a real monitor-sized capture passes.
2. **Duplicate check (dHash)** — the image is reduced to a 64-bit difference
   hash (9×8 grayscale, each pixel compared to its right neighbour). Two shots
   are "the same" if their **Hamming distance ≤ `dupeHammingThreshold`**. This
   survives Discord's re-encoding and minor crops, so re-uploading the same
   screenshot (what `Ignatiusfiery` tried) collides and is flagged.
3. **Ad-match check (OCR)** — `tesseract.js` reads the screenshot's text and
   fuzzy-matches it against the **stored running ads** (managed with `!addad` /
   `!listads` / `!togglead` / `!removead`). The ad counts as run if at least
   `adMatchThreshold` (default 60%) of one stored ad's significant words appear,
   with a small edit-distance allowance so OCR slips are forgiven. If
   `requireIgnInScreenshot` is on, the submitter's IGN must also be visible.
   This stops both fake screenshots and people advertising the wrong thing.

Hashes are stored in `adbot.json`; every new submission is checked against all
prior ones. OCR adds a couple of seconds per submission (the bot shows a typing
indicator while it reads). The first OCR run downloads the language data once.

> Note: OCR is a strong signal but not bulletproof — usernames with unusual
> characters can be misread. If legit submissions get rejected, set
> `requireIgnInScreenshot: false` or adjust `adVerifyKeyword` in `config.js`.

## Files

- `index.js` — Discord client, command + submission handlers
- `config.js` — all knobs + the `LEVELS` table
- `levels.js` — pure XP/level math
- `hashing.js` — dHash + Hamming-distance duplicate detection
- `db.js` — SQLite (better-sqlite3) persistence
- `embeds.js` — the Lemonade-style embeds
- `test.js` — checks (`npm test`)

## Notes

- Data lives in `adbot.sqlite` (created on first run; gitignored).
- The economy is self-contained (virtual balances). To pay out to a real
  Minecraft server, hook `recordAdReward` / `withdraw` in `db.js` up to your
  server's economy API or a payment webhook.
