'use strict';
// Content fingerprints for change detection (crawled pages, product criteria).
// FNV-1a 64-bit: fast, dependency-free and deterministic. Not a security hash.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

// Makes a fingerprint of the text.
function contentHash(text) {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(String(text))) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

// JSON with sorted keys, so equal objects always produce equal strings.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const body = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

module.exports = { contentHash, stableStringify };
