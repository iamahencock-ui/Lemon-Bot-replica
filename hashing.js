// ---------------------------------------------------------------------------
// hashing.js — perceptual duplicate detection for ad screenshots.
//
// Uses dHash (difference hash): resize to 9x8 grayscale, compare each pixel to
// its right neighbour -> 64 bits. dHash is robust to recompression, resizing,
// and minor cropping, so re-uploads of the same screenshot collide even after
// Discord re-encodes them, while two genuinely different in-game moments don't.
//
// Duplicate test = Hamming distance (number of differing bits) <= threshold.
// ---------------------------------------------------------------------------
import sharp from "sharp";

// Compute a 64-bit dHash, returned as a 16-char hex string.
export async function dhash(buffer) {
  // 9 wide so each row yields 8 left-vs-right comparisons.
  const { data } = await sharp(buffer)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      bits <<= 1n;
      if (left > right) bits |= 1n;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

// Number of differing bits between two hex hashes.
export function hammingDistance(a, b) {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

// Scan existing hashes for the closest match within `threshold`.
// existing: array of { discord_id, hash }. Returns the matching row plus the
// distance, or null if nothing is close enough.
export function findDuplicate(hash, existing, threshold) {
  let best = null;
  for (const row of existing) {
    const d = hammingDistance(hash, row.hash);
    if (d <= threshold && (best === null || d < best.distance)) {
      best = { ...row, distance: d };
      if (d === 0) break;
    }
  }
  return best;
}

// Width/height of an image buffer (for the minimum-size / full-screen check).
export async function imageMeta(buffer) {
  const { width, height } = await sharp(buffer).metadata();
  return { width: width ?? 0, height: height ?? 0 };
}
