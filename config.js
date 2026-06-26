// ---------------------------------------------------------------------------
// config.js — all tunable knobs for the ad-reward bot.
// Tune these to taste — every knob is read from here, nothing is hard-coded.
// Edit freely; nothing here is hard-coded elsewhere.
// ---------------------------------------------------------------------------

export const config = {
  // Command prefix for message commands.
  prefix: "!",

  // --- Ad economy -----------------------------------------------------------
  xpPerAd: 7, // each verified ad grants this much XP
  cashPerAd: 50, // each verified ad grants this much in-game currency
  cooldownMs: 10 * 60 * 1000, // 10 minutes between ads
  currencySymbol: "$", // shown in embeds ("$50")

  // Ads are managed in the database, not hard-coded here. Admins add them with
  // `!addad <full ad text>`; players see the running list with `!ad` and the
  // OCR check matches their screenshot against these stored ads.

  // --- Screenshot duplicate detection --------------------------------------
  // Two images whose perceptual (dHash) Hamming distance is <= this are treated
  // as the same screenshot. 0 = byte-identical only; higher = more aggressive.
  // 5 catches re-uploads, recompression, and minor crops without false-flagging
  // two genuinely different in-game moments.
  dupeHammingThreshold: 5,

  // --- Full-screen check ----------------------------------------------------
  // We demand the ENTIRE screen. A real desktop screenshot is large and
  // has a monitor-like aspect ratio; a cropped chat box does not. Reject crops.
  minImageWidth: 1000,
  minImageHeight: 560,
  minAspect: 1.3, // 4:3 = 1.33, 16:10 = 1.6, 16:9 = 1.78
  maxAspect: 2.4, // ultrawide 21:9 = 2.33

  // --- Ad verification (OCR) ------------------------------------------------
  // After the full-screen check, the bot reads the screenshot's text and
  // fuzzy-matches it against the stored ads. The ad "ran" if enough of one
  // stored ad's words are found in the screenshot.
  //
  // adMatchThreshold: fraction (0–1) of a stored ad's significant words that
  // must appear. 0.6 = 60%. Lower = more lenient (more OCR error tolerated),
  // higher = stricter. Single-character OCR slips on individual words are also
  // forgiven via a small edit-distance allowance.
  adMatchThreshold: 0.6,
  adWordMinLen: 3, // ignore tiny words ("or", "at") when matching

  // OCR is memory- and CPU-heavy. Process at most this many at once and queue
  // the rest, so a burst of submissions can't crash a small host. On a ~512MB–
  // 1GB box keep concurrency at 1. maxQueue caps how many wait before the bot
  // tells extra submitters it's busy (bounds memory).
  ocrConcurrency: 1,
  ocrMaxQueue: 50,
  // Require the submitter's IGN to also appear in the screenshot. OFF by
  // default: usernames are small/low-contrast and the most error-prone thing
  // for OCR, so requiring them causes false rejections. The ad-text match,
  // duplicate check, and full-screen check already prove a real, unique
  // broadcast. Turn this on only if your screenshots reliably show the name.
  requireIgnInScreenshot: false,

  // --- Tickets --------------------------------------------------------------
  // When set, !ign renames the ticket channel to the user's IGN.
  renameTicketOnIgn: true,
  // Prefix for new ticket channel names (before the user's name).
  ticketNamePrefix: "ticket-",
  // Title/description on the panel posted by !setup.
  panelTitle: "🍄 Gnomeads — get paid to get gnoming!",
  panelDescription:
    "Pop the button below to dig your own private burrow (ticket). Inside, plant " +
    "your in-game gname, peek at the ads you can run, and send screenshots to earn " +
    "XP and shiny rewards. Gnice and simple!",
  // Message shown at the top of every new ticket.
  ticketWelcome:
    "Welcome gnome! 🍄 Type `!ign <your username>` to get rooted, then `!ad` to see what's worth gnoming about.",

  // --- Cooldown reminder ----------------------------------------------------
  // Ping the user in their ticket when the cooldown expires.
  remindWhenCooldownEnds: true,

  // --- Payouts --------------------------------------------------------------
  // If a DC Treasury API token is configured (DC_API_TOKEN), !withdraw pays the
  // advertiser automatically in-game. This memo is attached to the transfer.
  payoutMemo: "Gnomeads payout for {ign} — gnice work!",

  // Fallback when NO API token is set: !withdraw instead posts this command for
  // a human to run. {ign}/{amount} are filled in.
  payoutBotName: "@server",
  payoutCommandHint: "/pay player:{ign} amount:{amount}",
};

// ---------------------------------------------------------------------------
// Level table. xp = cumulative XP required to REACH this level.
// reward = cash bonus granted on reaching it, or "STAFF_ROLE" for a role grant.
// Extend this array to add more levels; the engine reads it dynamically.
// ---------------------------------------------------------------------------
export const LEVELS = [
  { level: 1, xp: 0, reward: 0 },
  { level: 2, xp: 21, reward: 100 },
  { level: 3, xp: 56, reward: 150 },
  { level: 4, xp: 105, reward: 500 },
  { level: 5, xp: 126, reward: 75 },
  { level: 6, xp: 161, reward: 125 },
  { level: 7, xp: 210, reward: "STAFF_ROLE" },
  { level: 8, xp: 238, reward: 100 },
  { level: 9, xp: 273, reward: 125 },
  { level: 10, xp: 315, reward: 150 },
  { level: 11, xp: 385, reward: 500 },
  { level: 12, xp: 406, reward: 75 },
  { level: 13, xp: 441, reward: 150 },
  { level: 14, xp: 490, reward: 350 },
  { level: 15, xp: 525, reward: 125 },
  { level: 16, xp: 553, reward: 75 },
  { level: 17, xp: 588, reward: 100 },
  { level: 18, xp: 693, reward: 1000 },
  { level: 19, xp: 728, reward: 125 },
  { level: 20, xp: 749, reward: 75 },
  { level: 21, xp: 805, reward: 300 },
];
