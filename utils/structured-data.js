// utils/structured-data.js
// Runs inside a content script (has document access).
// Every listing site increasingly embeds structured JSON somewhere in the
// page — JSON-LD, Next.js __NEXT_DATA__, Nuxt __NUXT__, or a window.*
// state object. Reading that JSON is far more robust than chasing CSS
// classnames, which frameworks rename on every deploy. CSS selectors are
// used only as a last-resort fallback in each site's parser module.

import {
  getNextData as sharedGetNextData,
  getJsonLdBlocks as sharedGetJsonLdBlocks,
  findJsonLdByType as sharedFindJsonLdByType,
} from "../parser/shared-extractors.js";

export function getJsonLdBlocks() {
  return sharedGetJsonLdBlocks(document);
}

export function findJsonLdByType(typeName) {
  return sharedFindJsonLdByType(document, typeName);
}

export function getNextData() {
  return sharedGetNextData(document);
}

export function getMetaContent(name) {
  const el =
    document.querySelector(`meta[name="${name}"]`) ||
    document.querySelector(`meta[property="${name}"]`);
  return el ? el.getAttribute("content") : null;
}

export function getOpenGraph() {
  return {
    title: getMetaContent("og:title"),
    description: getMetaContent("og:description"),
    image: getMetaContent("og:image"),
    url: getMetaContent("og:url"),
  };
}

export function getCanonicalUrl() {
  const el = document.querySelector('link[rel="canonical"]');
  return el ? el.getAttribute("href") : null;
}

// Walks an arbitrary object graph looking for the first key matching one
// of `keyNames` (case-insensitive). Used to pull a field out of a large,
// unpredictable __NEXT_DATA__ tree without hardcoding its exact path,
// which changes between site deploys.
export function deepFind(obj, keyNames, maxDepth = 8, _depth = 0, _seen = new WeakSet()) {
  if (obj === null || typeof obj !== "object" || _depth > maxDepth) return undefined;
  if (_seen.has(obj)) return undefined;
  _seen.add(obj);

  const lowerNames = keyNames.map((k) => k.toLowerCase());
  for (const key of Object.keys(obj)) {
    if (lowerNames.includes(key.toLowerCase())) {
      const val = obj[key];
      if (val !== null && val !== undefined && val !== "") return val;
    }
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === "object") {
      const found = deepFind(val, keyNames, maxDepth, _depth + 1, _seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// Scans the page for a short text node matching one of `labelPatterns`
// (e.g. "BUA", "Plot Size", "Agent") and returns the nearest adjacent
// text as that label's value. This is a fallback for spec-sheet-style
// fields ("label: value" pairs rendered as sibling elements) that aren't
// in JSON-LD/__NEXT_DATA__/the description sentence.
//
// Why this instead of another CSS-class guess: class names churn on every
// deploy, but the human-readable label text ("Plot Size", "Agent") is
// copy a site is unlikely to change often. It's still a heuristic guess
// about DOM *shape* (that the value sits in a sibling element), which I
// haven't been able to verify against Bayut's live markup — if it comes
// back null, the fastest fix is you sending me a screenshot of that one
// spec row's HTML (right-click the label on the page → Inspect).
export function scanLabeledValue(document, labelPatterns) {
  const candidates = document.querySelectorAll("body *");
  for (const el of candidates) {
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent.trim())
      .join(" ")
      .trim();
    if (!ownText || ownText.length > 40) continue; // labels are short; skip paragraphs
    if (!labelPatterns.some((re) => re.test(ownText))) continue;

    // Try the next sibling element first (common "label / value" pair layout).
    const sib = el.nextElementSibling;
    if (sib) {
      const t = sib.textContent.trim();
      if (t && t.length < 80) return t;
    }
    // Fall back to any other short-text sibling under the same parent
    // (covers "label" and "value" both being children of one row wrapper).
    const parent = el.parentElement;
    if (parent) {
      for (const s of parent.children) {
        if (s === el) continue;
        const t = s.textContent.trim();
        if (t && t.length > 0 && t.length < 80) return t;
      }
    }
  }
  return null;
}
