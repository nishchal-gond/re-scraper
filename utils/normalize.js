// utils/normalize.js
// Pure functions. No DOM access here so they're unit-testable in isolation.
// Every function returns null on failure/ambiguity rather than a guessed value —
// per the spec's "mark unavailable as NULL instead of incorrect" requirement.

export function normalizeWhitespace(str) {
  if (str === null || str === undefined) return null;
  const cleaned = String(str).replace(/\s+/g, " ").trim();
  return cleaned.length ? cleaned : null;
}

export function normalizeNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  // Strip currency symbols, commas, "AED", "sqft", non-numeric noise, keep sign/decimal.
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function normalizePrice(value) {
  // Handles "AED 1,250,000", "1.25M", "AED 85,000 / year"
  if (value === null || value === undefined) return null;
  let str = String(value).toUpperCase().replace(/AED|YEAR|YR|\/|PER|MONTH/g, " ");
  const millionMatch = str.match(/([\d.]+)\s*M\b/);
  if (millionMatch) return Math.round(parseFloat(millionMatch[1]) * 1_000_000);
  const kMatch = str.match(/([\d.]+)\s*K\b/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1_000);
  return normalizeNumber(str);
}

export function normalizeBedrooms(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim().toUpperCase();
  if (str === "STUDIO" || str === "S") return 0;
  const n = normalizeNumber(str);
  return n === null ? null : Math.round(n);
}

export function normalizeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function normalizeBoolean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const str = String(value).trim().toLowerCase();
  if (["yes", "true", "furnished", "available", "1"].includes(str)) return true;
  if (["no", "false", "unfurnished", "unavailable", "0"].includes(str)) return false;
  return null;
}

export function normalizeCoordinate(value, kind /* 'lat' | 'lng' */) {
  const n = normalizeNumber(value);
  if (n === null) return null;
  if (kind === "lat" && (n < -90 || n > 90)) return null;
  if (kind === "lng" && (n < -180 || n > 180)) return null;
  return n;
}

// Turns a raw value into displayable text. Handles the shapes seen in the
// wild across both sites:
//   - a plain string ("Emaar Properties")
//   - a plain number
//   - an object wrapping the real label, e.g. {name:"Emaar Properties", id:9}
//     or {title:...} / {label:...} / {value:...} / {text:...}
// Blindly doing String(obj) on the object case produces the literal text
// "[object Object]" — that bug hit amenities first (array of these), then
// showed up again on PropertyFinder's `developer` field (a single object,
// not an array) once amenities was fixed. Route ANY field that might be
// object-shaped through this instead of normalizeWhitespace directly.
export function normalizeLabel(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    const label = v.name ?? v.title ?? v.label ?? v.text ?? v.value ?? null;
    if (label != null && typeof label !== "object") return normalizeWhitespace(label);
    return null; // no readable label found on this object — drop it, don't fake one
  }
  return normalizeWhitespace(v);
}

export function normalizeArray(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const cleaned = value.map(normalizeLabel).filter(Boolean);
    return cleaned.length ? cleaned.join("; ") : null;
  }
  return normalizeWhitespace(value);
}

export function dedupeKey(listing) {
  // Two listings are the same property posting if they share a reference
  // number, or failing that, the exact canonical/source URL.
  return listing.reference_number
    ? `ref:${listing.reference_number}`
    : `url:${listing.canonical_url || listing.source_url}`;
}
