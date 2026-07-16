// parser/bayut.js
//
// STATUS: Primary target, structure verified against Bayut's public URL
// conventions and known page architecture (Next.js SSR, JSON-LD product
// markup, /property/details-<id>.html listing URLs, ?page=N pagination).
//
// IMPORTANT — read before relying on this in production:
// I built and reasoned about this parser without being able to render
// Bayut's live JavaScript in my sandbox (no headless browser available
// here), so the CSS-selector fallback paths are my best inference from
// documented Bayut URL/data conventions, not something I clicked through
// and verified pixel-by-pixel today. Sites change their markup often.
// The JSON-LD / __NEXT_DATA__ extraction paths are the resilient part —
// they don't care about CSS class names — but you MUST run the
// "Test Parser" button in the popup on a real Bayut page before a full
// scrape, and use the built-in DevTools inspector (see README) to patch
// any selector that comes back null.
//
// Bayut is known to run bot-detection (see README > Anti-Bot Reality).
// This parser makes NO attempt to bypass CAPTCHA/Cloudflare — it detects
// and pauses instead (see detectBlocker below).

import {
  findJsonLdByType,
  getNextData,
  getOpenGraph,
  getCanonicalUrl,
  deepFind,
  scanLabeledValue,
} from "../utils/structured-data.js";
import {
  normalizeWhitespace,
  normalizeNumber,
  normalizePrice,
  normalizeBedrooms,
  normalizeCoordinate,
  normalizeBoolean,
  normalizeArray,
  normalizeLabel,
  normalizeDate,
} from "../utils/normalize.js";
import { makeListingId } from "../models/listing-schema.js";

export const siteName = "bayut";

// Bayut's JSON-LD `description` field follows a consistent template, e.g.:
//   "5-bed, 7-bath, 12,144 sqft penthouse for sale at Six Senses Residences
//    Dubai Marina, Dubai Marina for AED 25,000,000, listed by XYZ Real Estate."
//   "Studio, 1-bath, 540 sqft apartment for sale at JW Marriott Hotel
//    Marina, Dubai Marina for AED 1,550,000, listed by ..."
// This turned out to be a far more reliable source for bedrooms/bathrooms/
// size/type/purpose/community/agency than guessing __NEXT_DATA__ key names
// blind (those guesses came back mostly null against the real site — see
// the fallback order in extractListing below). Confidence in this regex is
// based on the actual scraped output the user shared, not a live-DOM test,
// so if Bayut varies the template for some listing types, some rows may
// still come back partially null — that's expected, not a crash.
function parseDescriptionSpecs(description) {
  if (!description) return {};
  // Two observed formats: "5-bed, 7-bath, ..." and, for studios,
  // "Studio, 1-bath, ..." (no "-bed" suffix on the Studio token).
  //
  // FIXED (previously matched ZERO real rows, which was the root cause of
  // almost every column coming back empty):
  //   1. The price clause was only written to accept a slash form
  //      ("AED 85,000 / year"), but every real Bayut row actually reads
  //      "AED 59,998 yearly" (a word, no slash) — that mismatch alone made
  //      the whole regex fail on 100% of rent listings.
  //   2. The old pattern ended in `\.?$`, anchoring the "listed by <agency>"
  //      capture to the literal end of the string. But Bayut always tacks
  //      on a trailing sentence after the agency name — e.g. "...listed by
  //      Oscar Real Estate. View floor plan, amenities & more." — so the
  //      hard `$` anchor could never be satisfied and the match failed even
  //      once fix #1 was applied. Now we just stop the agency capture at
  //      the first period instead of demanding end-of-string.
  // FIXED (round 2): apartments and villas use two DIFFERENTLY-WORDED
  // templates, confirmed from real scrape output —
  //   apartment: "...apartment for sale AT Rapunzel Tower, Living Legends
  //               FOR AED 1,650,000, listed by..."
  //   villa:     "...villa IS for sale IN Verdana 2, Dubai Investments
  //               Park (DIP) AT AED 1,218,000, listed by..."
  // The connecting words ("for...at...for AED" vs "is for...in...at AED")
  // differ, not just the property type — a single fixed sequence of
  // literal words could only ever match one of the two, which is why every
  // villa row previously came back completely empty even after round 1's
  // fix (round 1 only fixed the "yearly" wording and the trailing-sentence
  // anchor, both apartment-specific). Both connector shapes are now
  // accepted as alternatives.
  const m = description.match(
    /^(?:(Studio)|(\d+)-bed),\s*(\d+)-bath,\s*([\d,]+)\s*sqft\s+([a-z\s]+?)\s+(?:for\s+(sale|rent)\s+at|is\s+for\s+(sale|rent)\s+in)\s+([^,]+),\s*([^,]+?)\s+(?:for|at)\s+AED\s*([\d,]+)(?:\s*(?:\/\s*|\s+)(?:yearly|monthly|year|month))?\b,?\s*(?:listed by\s+([^.]+))?/i
  );
  if (!m) return {};
  const [, studioTag, beds, baths, sqft, propType, purposeA, purposeB, building, area, price, agency] = m;
  const purposeRaw = purposeA || purposeB;
  const purpose = purposeRaw ? purposeRaw[0].toUpperCase() + purposeRaw.slice(1).toLowerCase() : null;
  const priceNum = normalizeNumber(price);
  const out = {
    bedrooms: normalizeBedrooms(studioTag ? "STUDIO" : beds),
    bathrooms: normalizeNumber(baths),
    size_sqft: normalizeNumber(sqft),
    property_type: normalizeWhitespace(propType),
    purpose,
    community: normalizeWhitespace(area),
    agency: normalizeWhitespace(agency),
  };
  // "Rent" listings quote an ANNUAL figure ("AED 59,998 yearly") — that
  // belongs in annual_rent_aed, not price_aed (price_aed is for sale
  // listings). Previously this distinction wasn't made at all and rent
  // amounts were never written to any column.
  if (/rent/i.test(purpose || "")) {
    out.annual_rent_aed = priceNum;
  } else {
    out.price_aed = priceNum;
  }
  return out;
}

// ---------------------------------------------------------------------
// Automatic Dynamic Price Range Segmentation support
// (see background/service-worker.js autoSplitScrape / computePriceRanges).
//
// A very large Bayut search (thousands of listings) needs to be cut into
// price-band slices to stay under the per-slice listing cap the user
// configures (default 900). These three helpers make that possible
// without ever hardcoding a fixed AED increment — the engine decides how
// wide each band is at runtime, based on how many listings an actual
// probe of that band returns.
//
//   - getResultsCount: read the total listing count for the CURRENT
//     filters (whatever price band, if any, is already in the URL).
//     This is what the engine calls, repeatedly, while it narrows a
//     price band down to something under the cap.
//   - getPriceBounds: best-effort read of the true lowest/highest listing
//     price for the current (unfiltered) search, so segmentation starts
//     from the real floor/ceiling of the data instead of an arbitrary
//     guess. Returns null (engine uses configured settings) if it can't
//     find one.
//   - buildPriceFilteredUrl: apply a [min, max] price band to a search
//     URL, replacing whatever price filter (if any) was already there.
//
// STATUS: same caveat as the rest of this file — the query param names
// and the __NEXT_DATA__ key names below are my best inference from
// Bayut's known URL conventions, not something I clicked through and
// confirmed live today. If getResultsCount() returns null on a real
// Bayut page, check the selector/key names here first; the engine will
// otherwise fall back to a slower page-probing method automatically
// rather than silently under- or over-counting.
// ---------------------------------------------------------------------

export function getResultsCount(document) {
  // Try structured data first: Bayut's search API response (embedded via
  // __NEXT_DATA__ for the SSR'd first page) generally carries the total
  // hit count for the current filters somewhere in its props tree.
  const nextData = getNextData();
  if (nextData) {
    const props = nextData.props?.pageProps || nextData.props || nextData;
    const fromData = deepFind(props, ["hits", "totalResults", "resultCount", "total", "totalHits"]);
    const n = normalizeNumber(fromData);
    if (Number.isFinite(n)) return n;
  }
  // Fallback: the visible "N properties for sale/rent in <area>" heading
  // Bayut renders above the results grid.
  const el = document.querySelector('h1, [aria-label*="results" i], [class*="results" i]');
  if (el) {
    const m = el.textContent.match(/([\d,]+)\s*(properties|results)/i);
    if (m) return normalizeNumber(m[1]);
  }
  return null;
}

export function getPriceBounds(document) {
  // Best-effort: Bayut's filter panel (the price range slider) is driven
  // by a min/max facet that's often present in the same __NEXT_DATA__
  // tree as the results. If it's not there under any of these guessed
  // key names, return null and let the engine fall back to the
  // configured price floor/ceiling (Settings) instead of guessing wrong.
  const nextData = getNextData();
  if (!nextData) return null;
  const props = nextData.props?.pageProps || nextData.props || nextData;
  const min = normalizeNumber(deepFind(props, ["minPrice", "priceMin", "lowestPrice"]));
  const max = normalizeNumber(deepFind(props, ["maxPrice", "priceMax", "highestPrice"]));
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
    return { min, max };
  }
  return null;
}

export function buildPriceFilteredUrl(baseUrl, minPrice, maxPrice) {
  const u = new URL(baseUrl);
  // Best-guess param names, consistent with Bayut's documented filter
  // conventions (?price_min=&price_max=). Adjust here if a live check
  // shows different query param names.
  if (minPrice != null) u.searchParams.set("price_min", String(Math.round(minPrice)));
  else u.searchParams.delete("price_min");
  if (maxPrice != null) u.searchParams.set("price_max", String(Math.round(maxPrice)));
  else u.searchParams.delete("price_max");
  // Always start a fresh slice at page 1 — Bayut encodes page in the
  // path (page-N/), not a query param, so strip that too if present.
  let path = u.pathname.replace(/\/page-\d+\/?$/, "/");
  if (!path.endsWith("/")) path += "/";
  u.pathname = path;
  return u.toString();
}

export function matches(url) {
  return /(^https?:\/\/)?(www\.)?bayut\.com\//.test(url);
}

export function pageType(url) {
  if (/\/property\/details-[\w-]+\.html/.test(url)) return "listing";
  if (/\/(for-sale|to-rent)\//.test(url)) return "search";
  return "unknown";
}

// Detects Bayut's interstitial bot-check / CAPTCHA page so the engine can
// pause instead of silently recording garbage data.
export function detectBlocker(document) {
  const bodyText = document.body ? document.body.innerText.slice(0, 2000) : "";
  const blockers = [
    /checking your browser/i,
    /verify you are human/i,
    /captcha/i,
    /access denied/i,
    /unusual traffic/i,
  ];
  return blockers.some((re) => re.test(bodyText));
}

export function collectListingLinks(document) {
  const seen = new Set();
  const results = [];
  // Every real Bayut listing detail link matches this path pattern
  // regardless of which card component/classnames wrap it.
  const anchors = document.querySelectorAll('a[href*="/property/details-"]');
  let position = 0;
  anchors.forEach((a) => {
    let href = a.getAttribute("href");
    if (!href) return;
    if (href.startsWith("/")) href = "https://www.bayut.com" + href;
    // Strip tracking query params so the same listing isn't recorded twice
    // under two different URLs.
    try {
      const u = new URL(href);
      href = u.origin + u.pathname;
    } catch (e) {
      return;
    }
    if (seen.has(href)) return;
    seen.add(href);
    position += 1;
    results.push({ url: href, position });
  });
  return results;
}

export function detectPagination(document, currentUrl) {
  // Bayut's actual convention (confirmed from a live URL:
  // .../for-sale/property/dubai/dubai-marina/page-2/) is a PATH segment
  // "page-N/", not a "?page=N" query string. My first attempt assumed the
  // query-param convention, which Bayut silently ignores — every
  // "next page" request just re-rendered page 1, and the engine looped
  // forever thinking it kept finding a fresh page 1. Fixed to match the
  // real convention: page 1 has no page segment at all; page N>1 has a
  // trailing "page-N/" segment.
  let currentPage = 1;
  const pathMatch = currentUrl.match(/\/page-(\d+)\/?(?:[?#]|$)/);
  if (pathMatch) {
    const p = parseInt(pathMatch[1], 10);
    if (Number.isFinite(p) && p > 0) currentPage = p;
  }

  // Try to read an explicit total-pages count if Bayut exposes it in
  // visible pagination links (best-effort, used only for the progress UI —
  // it is NOT relied on to decide whether to continue, see below).
  let totalPages = null;
  const pageLinks = document.querySelectorAll('a[href*="/page-"]');
  pageLinks.forEach((a) => {
    const m = a.getAttribute("href")?.match(/\/page-(\d+)\/?/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) totalPages = Math.max(totalPages || 0, n);
    }
  });

  // IMPORTANT: we do NOT require finding a real <a href="?page=N"> element
  // to decide whether a next page exists. Bayut's pagination control is
  // rendered client-side (a JS button, not a plain link in most cases),
  // so searching for an anchor tag here found nothing on a real page and
  // caused the engine to stop after page 1 even though thousands of
  // listings remained. Instead we ALWAYS construct the next page URL
  // optimistically — Bayut's search pages accept ?page=N directly — and
  // let the engine itself decide to stop once a fetched page comes back
  // with zero listing links (the real signal that you've run past the
  // last page).
  // Construct the next page's URL using the path-segment convention:
  //   currentUrl with any existing "page-N/" segment stripped, then
  //   "page-{next}/" appended before the query string (if any).
  let nextPageUrl = null;
  try {
    const u = new URL(currentUrl);
    let path = u.pathname.replace(/\/page-\d+\/?$/, "/"); // strip existing page segment
    if (!path.endsWith("/")) path += "/";
    path += `page-${currentPage + 1}/`;
    u.pathname = path;
    nextPageUrl = u.toString();
  } catch (e) {
    nextPageUrl = null;
  }

  return {
    currentPage,
    totalPages,
    nextPageUrl,
    mode: "numbered",
  };
}

export function extractListing(document, sourceUrl) {
  const listing = {};
  listing.source_url = sourceUrl;
  listing.source_site = siteName;
  listing.canonical_url = getCanonicalUrl() || sourceUrl;

  const og = getOpenGraph();
  listing.og_image = og.image;

  // --- 1. JSON-LD (schema.org Product/RealEstateListing/Residence) ---
  const jsonLdBlocks = [
    ...findJsonLdByType("Product"),
    ...findJsonLdByType("RealEstateListing"),
    ...findJsonLdByType("Residence"),
    ...findJsonLdByType("Apartment"),
    ...findJsonLdByType("SingleFamilyResidence"),
  ];
  listing.json_ld_present = jsonLdBlocks.length > 0;
  const ld = jsonLdBlocks[0] || {};

  listing.title = normalizeWhitespace(ld.name) || og.title || null;
  listing.description = normalizeWhitespace(ld.description) || og.description || null;

  if (ld.offers) {
    const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
    listing.price_aed = normalizePrice(offer?.price);
  }
  if (ld.address) {
    listing.community =
      normalizeWhitespace(ld.address.addressLocality) || null;
  }

  // --- 2. __NEXT_DATA__ deep search (fills gaps JSON-LD doesn't cover) ---
  const nextData = getNextData();
  let refNum = null;
  if (nextData) {
    const props = nextData.props?.pageProps || nextData.props || nextData;

    refNum = normalizeWhitespace(deepFind(props, ["referenceNumber", "reference"]));

    listing.bedrooms =
      listing.bedrooms ?? normalizeBedrooms(deepFind(props, ["rooms", "bedrooms"]));
    listing.bathrooms =
      listing.bathrooms ?? normalizeNumber(deepFind(props, ["baths", "bathrooms"]));
    listing.size_sqft =
      listing.size_sqft ?? normalizeNumber(deepFind(props, ["area", "size", "sizeSqft"]));
    // NOTE: deliberately NOT searching a bare "type" key here — __NEXT_DATA__
    // trees are large and "type" is generic enough that deepFind's
    // breadth-first walk can match an unrelated node (e.g. a UI/component
    // type flag) before it ever reaches the real property type, silently
    // returning garbage like "list" instead of "Apartment".
    listing.property_type = normalizeWhitespace(
      deepFind(props, ["propertyType", "category", "propertySubType"])
    );
    listing.purpose = normalizeWhitespace(deepFind(props, ["purpose"]));
    listing.furnished = normalizeBoolean(deepFind(props, ["furnishingStatus", "furnished"]));
    listing.agency = normalizeLabel(deepFind(props, ["agencyName", "agency"]));
    listing.agent_name = normalizeLabel(deepFind(props, ["agentName", "contactName"]));
    listing.off_plan = normalizeBoolean(deepFind(props, ["isOffplan", "offPlan"]));
    listing.developer = normalizeLabel(
      deepFind(props, ["developerName", "developer", "projectDeveloper", "builderName"])
    );
    listing.amenities = normalizeArray(deepFind(props, ["amenities", "features"]));
    listing.parking = normalizeWhitespace(deepFind(props, ["parking"]));
    listing.floor = normalizeWhitespace(deepFind(props, ["floor"]));
  }

  // --- 2.5. Description-template parser (fills gaps 1 and 2 left null) ---
  // Runs AFTER json-ld/next-data so anything already found there wins;
  // this only patches fields that came back null.
  const fromDescription = parseDescriptionSpecs(listing.description);
  for (const [key, value] of Object.entries(fromDescription)) {
    if (listing[key] == null && value != null) listing[key] = value;
  }

  // --- 3. CSS fallback for anything still null (best-effort, unverified) ---
  // Kept intentionally minimal and defensive: only fills gaps, never
  // overwrites a value already found via structured data above.
  if (listing.price_aed == null) {
    const priceEl = document.querySelector('[aria-label*="Price" i], [class*="price" i]');
    if (priceEl) listing.price_aed = normalizePrice(priceEl.textContent);
  }
  if (listing.title == null) {
    const h1 = document.querySelector("h1");
    if (h1) listing.title = normalizeWhitespace(h1.textContent);
  }

  // --- 3.5. Label-scan fallback for spec-sheet fields (BUA, plot size,
  // agency, agent) — none of these appear in JSON-LD, __NEXT_DATA__ (at
  // least not under the key names I guessed), or the description
  // sentence, so this is the last line of defense before returning null.
  // See scanLabeledValue's doc comment in utils/structured-data.js for
  // why this approach (label-text search) rather than another blind
  // class-name guess, and what to send me if it still comes back empty.
  if (listing.BUA == null) {
    const v = scanLabeledValue(document, [/^BUA$/i, /built[\s-]?up\s*area/i]);
    if (v) listing.BUA = normalizeNumber(v);
  }
  if (listing.plot_size_sqft == null) {
    const v = scanLabeledValue(document, [/^plot\s*size$/i, /^plot\s*area$/i]);
    if (v) listing.plot_size_sqft = normalizeNumber(v);
  }
  if (listing.agency == null) {
    const v = scanLabeledValue(document, [/^agency$/i, /^agent\s*company$/i]);
    if (v) listing.agency = normalizeWhitespace(v);
  }
  if (listing.agent_name == null) {
    const v = scanLabeledValue(document, [/^agent$/i, /^listed\s*by$/i, /^contact\s*agent$/i]);
    if (v) listing.agent_name = normalizeWhitespace(v);
  }
  if (listing.developer == null) {
    const v = scanLabeledValue(document, [/^developer$/i, /^developed\s*by$/i]);
    if (v) listing.developer = normalizeWhitespace(v);
  }

  listing.listing_id = makeListingId(sourceUrl, refNum);
  listing.date_collected = new Date().toISOString();
  listing.last_updated = listing.date_collected;

  return listing;
}

export function buildSortedPriceDescendingUrl(baseUrl) {
  const u = new URL(baseUrl);
  u.searchParams.set("sort", "price-desc"); // sort: price-descending
  return u.toString();
}

export function extractSearchPageListings(document) {
  const listings = [];
  const seenUrls = new Set();

  // Try Next.js __NEXT_DATA__ first
  const nextData = getNextData();
  if (nextData) {
    function recurse(obj) {
      if (!obj || typeof obj !== "object") return;
      const hasPrice = obj.price !== undefined || obj.priceVal !== undefined;
      const hasPathOrUri = typeof obj.uri === "string" || typeof obj.path === "string" || typeof obj.shareUrl === "string";
      if (hasPrice && hasPathOrUri) {
        let url = obj.uri || obj.path || obj.shareUrl;
        if (url.startsWith("/")) {
          url = "https://www.bayut.com" + url;
        }
        let price = normalizeNumber(obj.price?.value || obj.price?.amount || obj.price || obj.priceVal);
        if (url && Number.isFinite(price) && price > 0) {
          try {
            const u = new URL(url);
            url = u.origin + u.pathname;
          } catch (e) {}
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            listings.push({ url, price });
          }
        }
      }
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          recurse(obj[key]);
        }
      }
    }
    recurse(nextData);
  }

  // Fallback to DOM parsing
  if (listings.length === 0) {
    const cards = document.querySelectorAll('a[href*="/property/details-"]');
    cards.forEach((card) => {
      let href = card.getAttribute("href");
      if (!href) return;
      if (href.startsWith("/")) href = "https://www.bayut.com" + href;
      try {
        const u = new URL(href);
        href = u.origin + u.pathname;
      } catch (e) {
        return;
      }
      if (seenUrls.has(href)) return;

      // Try finding price in parent or sibling DOM tree
      let container = card.parentElement;
      let price = null;
      let depth = 0;
      while (container && depth < 5 && price === null) {
        const priceText = container.textContent || "";
        const priceMatch = priceText.replace(/,/g, "").match(/(?:AED|USD)\s*(\d+)/i) || priceText.replace(/,/g, "").match(/(\d+)\s*(?:AED|USD)/i);
        if (priceMatch) {
          price = normalizeNumber(priceMatch[1]);
        }
        container = container.parentElement;
        depth++;
      }

      if (href && Number.isFinite(price) && price > 0) {
        seenUrls.add(href);
        listings.push({ url: href, price });
      }
    });
  }

  return listings;
}
