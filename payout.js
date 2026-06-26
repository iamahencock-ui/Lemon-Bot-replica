// ---------------------------------------------------------------------------
// payout.js — real in-game payouts via the DemocracyCraft Treasury REST API.
//
// Auth: a Bearer JWT issued in-game with `/treasuryapi personal issue` or
// `/treasuryapi business issue`. We send POST /api/v1/transfers/to-player to
// pay an advertiser by their Minecraft username.
//
// Notes from the API spec:
//  • amount is ALWAYS a decimal STRING (never a JSON number).
//  • Idempotency-Key header makes a retry safe (no double-pay).
//  • BUSINESS scope must name the source account via fromAccountId.
//  • JWTs expire, so we auto-rotate before expiry and persist the new token.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import * as store from "./db.js";

const BASE = process.env.DC_API_BASE || "https://api.democracycraft.net/economy";
const FROM_ACCOUNT_ID = process.env.DC_FROM_ACCOUNT_ID || null;

// Prefer the rotated token saved in the DB; fall back to the .env token.
function token() {
  return store.getApiToken() || process.env.DC_API_TOKEN || null;
}

export function payoutEnabled() {
  return !!token();
}

// ms timestamp of a JWT's exp claim, or null if it can't be read.
function jwtExpMs(jwt) {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")
    );
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Pay a player by username. Returns { ok, txnId } or { ok:false, error, message }.
export async function payPlayer(playerName, amount, memo) {
  const jwt = token();
  if (!jwt) {
    return { ok: false, error: "NO_TOKEN", message: "No DC API token set." };
  }
  const body = {
    toPlayerName: playerName,
    amount: Number(amount).toFixed(2), // decimal string, never a JSON number
    memo: memo || "Ad payout",
  };
  if (FROM_ACCOUNT_ID) body.fromAccountId = Number(FROM_ACCOUNT_ID);

  let res;
  try {
    res = await fetch(`${BASE}/api/v1/transfers/to-player`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: "NETWORK", message: e.message };
  }

  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, txnId: data.txnId, data };
  return {
    ok: false,
    status: res.status,
    error: data.error || `HTTP_${res.status}`,
    message: data.message || "",
  };
}

// Generic authenticated GET against the Treasury API.
async function apiGet(path) {
  const jwt = token();
  if (!jwt) return { ok: false, error: "NO_TOKEN" };
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch (e) {
    return { ok: false, error: "NETWORK", message: e.message };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, data };
  return {
    ok: false,
    status: res.status,
    error: data.error || `HTTP_${res.status}`,
    message: data.message || "",
  };
}

// What this token is (scope, firmId, personal accountId).
export function whoAmI() {
  return apiGet("/api/v1/auth/me");
}

// The firm's accounts (valid sources for DC_FROM_ACCOUNT_ID on a business key).
export function listFirmAccounts() {
  return apiGet("/api/v1/firms/me/accounts");
}

// Exchange the current token for a fresh one and persist it.
export async function rotateToken() {
  const jwt = token();
  if (!jwt) return false;
  let res;
  try {
    res = await fetch(`${BASE}/api/v1/auth/rotate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch (e) {
    console.warn("payout: token rotate network error —", e.message);
    return false;
  }
  if (!res.ok) {
    console.warn(`payout: token rotate failed (HTTP ${res.status}).`);
    return false;
  }
  const data = await res.json().catch(() => ({}));
  if (data.token) {
    store.setApiToken(data.token);
    scheduleRotate(jwtExpMs(data.token));
    console.log("payout: API token rotated.");
    return true;
  }
  return false;
}

let rotateTimer = null;
function scheduleRotate(expMs) {
  if (rotateTimer) clearTimeout(rotateTimer);
  if (!expMs) return;
  // Rotate 24h before expiry (or in 1 min if expiry is very near).
  const delay = Math.max(60_000, expMs - Date.now() - 24 * 60 * 60 * 1000);
  // setTimeout caps at ~24.8 days; clamp to be safe.
  rotateTimer = setTimeout(rotateToken, Math.min(delay, 2_000_000_000));
}

// Call once at startup: schedule auto-rotation based on the current token.
export function initPayout() {
  if (!payoutEnabled()) {
    console.log("payout: no DC API token — !withdraw will fall back to staff ping.");
    return;
  }
  scheduleRotate(jwtExpMs(token()));
  console.log("payout: DC Treasury auto-payout enabled.");
}
