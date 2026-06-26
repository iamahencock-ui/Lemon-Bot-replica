// ---------------------------------------------------------------------------
// test.js — run with `npm test`. Verifies the level/XP math against the values
// observed during testing, plus the perceptual-hash + matching behaviour.
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import {
  levelForXp,
  progress,
  nextBonus,
  applyAd,
  progressBar,
} from "./levels.js";
import { hammingDistance, dhash } from "./hashing.js";
import { bestAdMatch, ignPresent } from "./verify.js";

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

console.log("Level math (vs. screenshots):");

t("level boundaries", () => {
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(20), 1);
  assert.equal(levelForXp(21), 2); // L2 = 21 XP
  assert.equal(levelForXp(55), 2);
  assert.equal(levelForXp(56), 3); // L3 = 56 XP
  assert.equal(levelForXp(805), 21); // top of table
});

t("progress at 7 XP = 7/21, 33%", () => {
  const p = progress(7);
  assert.equal(p.current, 7);
  assert.equal(p.needed, 21);
  assert.equal(p.pct, 33); // screenshot showed 33%
});

t("progress at 21 XP = 0/35, 0% (just hit L2)", () => {
  const p = progress(21);
  assert.equal(p.current, 0);
  assert.equal(p.needed, 35); // 56 - 21
  assert.equal(p.pct, 0);
});

t("next bonus: $100 at L1, $150 at L2", () => {
  assert.equal(nextBonus(7), 100); // screenshot 2
  assert.equal(nextBonus(21), 150); // screenshot 3
});

t("applyAd crossing into L2 grants $100 bonus", () => {
  const r = applyAd(14, 7); // 2 ads -> 3 ads = 21 XP
  assert.equal(r.newLevel, 2);
  assert.ok(r.leveledUp);
  assert.equal(r.bonusCash, 100);
  assert.deepEqual(r.crossedLevels, [2]);
});

t("applyAd not leveling grants no bonus", () => {
  const r = applyAd(0, 7); // 0 -> 7 XP, still L1
  assert.equal(r.newLevel, 1);
  assert.ok(!r.leveledUp);
  assert.equal(r.bonusCash, 0);
});

t("applyAd can cross multiple levels at once", () => {
  // jump from 0 to 60 XP would pass L2(21) and L3(56)
  const r = applyAd(0, 60);
  assert.equal(r.newLevel, 3);
  assert.deepEqual(r.crossedLevels, [2, 3]);
  assert.equal(r.bonusCash, 250); // 100 + 150
});

t("staff role at level 7", () => {
  const r = applyAd(161, 49); // L6(161) -> 210 = L7
  assert.ok(r.grantedStaffRole);
});

t("progressBar fills correctly", () => {
  assert.equal(progressBar(0), "░".repeat(10));
  assert.equal(progressBar(100), "█".repeat(10));
});

console.log("\nAd matching (OCR vs stored ads):");

const sampleAds = [
  {
    id: 1,
    text: "BUY or SELL anything at LEMONADE /gps c244 - CLOSE to /spawn - Blocks, drops, farm, colors, ores and MORE",
  },
  { id: 2, text: "Visit DIAMOND DEPOT /gps d100 cheapest tools in town" },
];

t("matches the right ad from a noisy screenshot", () => {
  const ocr =
    "Mechanic Respect_s the wild is the wild\n" +
    "AD » BUY or SELL anything at LEMONADE /gps c244 - CLOSE to /spawn - Blocks, drops, farm, colors, ores and MORE ~ Moski08\n" +
    "Armourer Sithmass what do you think";
  const m = bestAdMatch(ocr, sampleAds, { minWordLen: 3, threshold: 0.6 });
  assert.ok(m && m.ad.id === 1, "should match ad #1");
});

t("rejects unrelated text", () => {
  const m = bestAdMatch("hello there nothing relevant here", sampleAds, {
    minWordLen: 3,
    threshold: 0.6,
  });
  assert.equal(m, null);
});

t("tolerates OCR character errors", () => {
  // LEM0NADE, col0rs, bocks have OCR slips
  const ocr =
    "AD » BUY or SELL anything at LEM0NADE gps c244 CLOSE spawn bocks drops farm col0rs ores and MORE ~ Moski08";
  const m = bestAdMatch(ocr, sampleAds, { minWordLen: 3, threshold: 0.6 });
  assert.ok(m && m.ad.id === 1);
});

t("IGN found despite OCR character slips", () => {
  // O->0, l->i look-alikes
  assert.ok(ignPresent("AD » ... ~ Mosk1O8", "Moski08"));
  assert.ok(ignPresent("blah ~ Moski08 blah", "Moski08"));
  assert.equal(ignPresent("nothing relevant here", "Moski08"), false);
});

console.log("\nHashing:");

t("hammingDistance counts differing bits", () => {
  assert.equal(hammingDistance("0".repeat(16), "0".repeat(16)), 0);
  assert.equal(hammingDistance("0".repeat(16), "000000000000000f"), 4);
  assert.equal(hammingDistance("0".repeat(15) + "1", "0".repeat(16)), 1);
});

// dHash tests need sharp + generated images; skip gracefully if unavailable.
await (async () => {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.log("  -- sharp not installed, skipping dHash image tests");
    return;
  }
  const solid = (r, g, b) =>
    sharp({
      create: { width: 64, height: 64, channels: 3, background: { r, g, b } },
    })
      .png()
      .toBuffer();

  const gradient = () => {
    // horizontal gradient that DECREASES left->right, so every dHash
    // left>right comparison is true (bits set) -> distinct from a solid fill.
    const w = 64,
      h = 64,
      data = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        data[i] = data[i + 1] = data[i + 2] = Math.floor(((w - x) / w) * 255);
      }
    return sharp(data, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer();
  };

  const a = await dhash(await gradient());
  const b = await dhash(await gradient());
  const c = await dhash(await solid(10, 10, 10));

  t("identical images -> distance 0", () => {
    assert.equal(hammingDistance(a, b), 0);
  });
  t("different images -> larger distance", () => {
    assert.ok(hammingDistance(a, c) > 10);
  });
})();

console.log(`\n${pass} checks passed.`);
