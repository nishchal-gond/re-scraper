// parser/propertyfinder.js
//
// STATUS: SCAFFOLD — NOT VERIFIED AGAINST LIVE DOM.
// I could not render PropertyFinder.ae's JavaScript in this environment,
// so I don't have a confirmed CSS selector map for it the way I do for
// Bayut. What I've built here is the correct *shape* of a parser (matches
// the parser-interface contract) plus the same structured-data-first
// strategy (JSON-LD, __NEXT_DATA__), which is likely to work with little
// or no changes since PropertyFinder is also Next.js-based and PropTech
// sites in this market widely use schema.org Product/RealEstateListing
// markup for SEO. But treat every CSS selector below as a placeholder.
//
// TO ACTIVATE THIS PARSER FOR REAL USE:
//   1. Open a PropertyFinder search results page.
//   2. Open the popup > Settings > "Test Parser" (or DevTools console:
//      import and call collectListingLinks(document) manually).
//   3. If collectListingLinks() returns 0 results, open DevTools, inspect
//      a listing card, and update the selector in collectListingLinks().
//   4. Repeat for detectPagination() and extractListing() on a listing page.
//   5. Remove this banner once verified.

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
  normalizeArray,
  normalizeLabel,
  normalizeBoolean,
} from "../utils/normalize.js";
import { makeListingId } from "../models/listing-schema.js";

export const siteName = "propertyfinder";

// PropertyFinder's meta/JSON-LD description follows a consistent template
// confirmed from the user's real scrape output, e.g.:
//   "788 sqft Apartment for sale. WE AL BISHRI REAL ESTATE THE PREMIUM
//    AGENTS FOR CONTINENTAL TOWER We Pleased to Present One Bedroom..."
//   "2,200 sqft Apartment for sale. For Sale: Spacious 3-Bedroom..."
// This is a much more reliable source for size/type/purpose than guessing
// __NEXT_DATA__ key names blind, same lesson learned from the Bayut parser.
function parseDescriptionSpecs(description) {
  if (!description) return {};
  const m = description.match(
    /^([\d,]+)\s*sqft\s+([a-z\s]+?)\s+for\s+(sale|rent)\b/i
  );
  if (!m) return {};
  const [, sqft, propType, purposeRaw] = m;
  return {
    size_sqft: normalizeNumber(sqft),
    property_type: normalizeWhitespace(propType),
    purpose: purposeRaw[0].toUpperCase() + purposeRaw.slice(1).toLowerCase(),
  };
}

// PropertyFinder's listing URLs encode purpose and property type in the
// slug itself, e.g.:
//   .../apartment-for-sale-dubai-dubai-marina-continental-tower-83643060.html
//   .../villa-for-rent-dubai-arabian-ranches-...-12345678.html
// This is deterministic (no page markup involved at all) so it's used as
// the first-choice fallback when JSON-LD/__NEXT_DATA__ don't have it,
// ahead of the description-text guess above.
function parseUrlSlug(sourceUrl) {
  const out = {};
  try {
    const path = new URL(sourceUrl).pathname;
    const slug = path.split("/").filter(Boolean).pop() || "";
    const m = slug.match(/^([a-z-]+?)-for-(sale|rent)-/i);
    if (m) {
      out.property_type = normalizeWhitespace(m[1].replace(/-/g, " "));
      out.purpose = m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
    }
  } catch (e) {
    /* ignore malformed URL */
  }
  return out;
}

// PropertyFinder exposes total prices in multiple state shapes. A generic
// search for the first "price" field can pick a per-sq-ft or UI value.
function findListingPrice(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value !== "object" || depth > 10 || seen.has(value)) return null;
  seen.add(value);
  for (const key of ["priceAed", "priceAED", "sellingPrice", "salePrice", "totalPrice", "amount", "value"]) {
    const price = normalizePrice(value[key]);
    if (Number.isFinite(price) && price > 0) return price;
  }
  if (value.price && typeof value.price === "object") {
    const price = normalizePrice(value.price.value ?? value.price.amount ?? value.price.total);
    if (Number.isFinite(price) && price > 0) return price;
  }
  for (const key of Object.keys(value)) {
    const nested = value[key];
    if (nested && typeof nested === "object") {
      const price = findListingPrice(nested, depth + 1, seen);
      if (price != null) return price;
    }
  }
  return null;
}

function setPurposePrice(listing, rawPrice) {
  const price = normalizePrice(rawPrice);
  if (!Number.isFinite(price) || price <= 0) return;
  if (/rent/i.test(listing.purpose || "")) listing.annual_rent_aed = price;
  else listing.price_aed = price;
}
// ---------------------------------------------------------------------
// Auto-split support (see background/service-worker.js autoSplitScrape).
//
// PropertyFinder caps how deep a single search's pagination goes,
// independent of how many listings actually match. The workaround isn't
// to fight that cap — it's to narrow the search (price range is the
// easiest, always-available lever) into several slices that each stay
// under it, same as a person clicking through the filter UI themselves.
// These two helpers make that automatable:
//   - getResultsCount: read the "N properties" total PropertyFinder shows
//     for the current filters, so we know whether a slice needs splitting
//     WITHOUT having to page all the way to the cap just to find out.
//   - buildPriceFilteredUrl: apply a price band to a search URL.
//
// STATUS: same caveat as the rest of this file — selectors/param names
// below are best-effort, not confirmed against live markup. If
// getResultsCount() returns null on a real page, the engine automatically
// falls back to a slower "probe deep page" method instead of failing, so
// auto-split still works — just do verify/fix the selector here when you
// get a chance, since the count method is much cheaper.
// ---------------------------------------------------------------------

export function getResultsCount(document) {
  // 1. Check if there are absolutely no property cards on the page.
  // If no cards exist and the page loaded, the count is 0.
  const hasCards = document.querySelector(
    'a[data-testid*="property-card" i], a[class*="card-link" i], a[href*="/plp/"], a[href*=".html"]'
  );
  if (!hasCards) {
    if (detectBlocker(document)) return null;
    const bodyText = document.body?.innerText || "";
    if (/no\\s*(?:properties|results|listed|matching|listings)\\b/i.test(bodyText)) return 0;
    return null;
  }

  // Try a structured source first: __NEXT_DATA__ often carries the total
  // hit count from the search API response.
  const nextData = getNextData();
  if (nextData) {
    const props = nextData.props?.pageProps || nextData.props || nextData;
    const fromData = deepFind(props, ["totalResults", "resultCount", "total", "hits", "totalCount"]);
    const n = normalizeNumber(fromData);
    if (Number.isFinite(n)) return n;
  }
  
  // Robust Fallback: Scan text in headers and spans
  // Looking for "637 listed", "1,200 properties", or "0 properties"
  const elements = document.querySelectorAll("h1, h2, h3, h4, span, div");
  for (const el of elements) {
    // Only look at immediate text content to avoid matching giant parent divs
    let text = "";
    for (const child of el.childNodes) {
      if (child.nodeType === 3) text += child.textContent + " ";
    }
    text = text.trim();
    if (!text || text.length > 100) continue;
    
    // Check for explicit zero/no results text
    if (
      /no\s*(?:properties|results|listed|matching|listings)\b/i.test(text) ||
      /couldn't\s*find|don't\s*have\s*any/i.test(text)
    ) {
      return 0;
    }

    const m = text.match(/(?:^|\s)([\d,]+)\s*(properties|results|listed)\b/i);
    if (m) {
      const num = normalizeNumber(m[1]);
      if (Number.isFinite(num)) return num;
    }
  }

  // Final fallback for the specific h1 case where it might be mixed in child elements
  const h1 = document.querySelector('h1');
  if (h1) {
    const text = h1.textContent;
    if (/no\s*(?:properties|results|listed|matching)\b/i.test(text)) return 0;
    const m = text.match(/([\d,]+)\s*(properties|results|listed)/i);
    if (m) return normalizeNumber(m[1]);
  }

  return null;
}

export function buildPriceFilteredUrl(baseUrl, minPrice, maxPrice) {
  const u = new URL(baseUrl);
  // Best-guess param names — adjust here if PropertyFinder's actual
  // search page uses different ones (check the URL after manually
  // setting a price filter in their UI).
  if (minPrice != null) u.searchParams.set("pf", String(Math.round(minPrice)));
  else u.searchParams.delete("pf");
  if (maxPrice != null) u.searchParams.set("pt", String(Math.round(maxPrice)));
  else u.searchParams.delete("pt");
  u.searchParams.delete("page"); // always start a new slice at page 1
  return u.toString();
}

export function matches(url) {
  return /(^https?:\/\/)?(www\.)?propertyfinder\.ae\//.test(url);
}

export function pageType(url) {
  // Confirmed from a real URL the user hit:
  //   propertyfinder.ae/en/search?l=1&c=1&fu=0&ob=mr
  // — PropertyFinder's search-results path is "/search" with query params
  // (l/c/fu/ob = location/category/furnished/order-by, best guess at
  // their meaning, not that it matters for detection). My first version
  // only recognized /buy/ or /rent/ in the path, which this URL doesn't
  // have, so a real search page was being misclassified as "unknown" and
  // rejected. /buy/ and /rent/ are kept as a fallback in case some result
  // pages do use that older-style path.
  if (/-\d{5,}\.html/.test(url)) return "listing";
  if (/\/search(?:[/?]|$)/.test(url) || /\/(buy|rent)\//.test(url)) return "search";
  return "unknown";
}

export function detectBlocker(document) {
  const bodyText = document.body ? document.body.innerText.slice(0, 2000) : "";
  return /checking your browser|captcha|access denied|unusual traffic/i.test(bodyText);
}

export function collectListingLinks(document) {
  const pageText = document.body?.innerText || "";
  if (/no\s*properties\s*found|no\s*(?:properties|results|matching|listings)\b/i.test(pageText)) return [];
  // PLACEHOLDER selector — verify against live markup before use.
  const seen = new Set();
  const results = [];
  const anchors = document.querySelectorAll(
    'a[data-testid*="property-card" i], a[class*="card-link" i], a[href*="/plp/"], a[href*=".html"]'
  );
  let position = 0;
  anchors.forEach((a) => {
    let href = a.getAttribute("href");
    if (!href) return;
    if (href.startsWith("/")) href = "https://www.propertyfinder.ae" + href;
    try {
      const u = new URL(href);
            if (u.hostname !== "www.propertyfinder.ae" || (!/\/plp\//i.test(u.pathname) && !/-\d{5,}\.html$/i.test(u.pathname))) return;
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
  let currentPage = 1;
  try {
    const u = new URL(currentUrl);
    const p = parseInt(u.searchParams.get("page"), 10);
    if (Number.isFinite(p) && p > 0) currentPage = p;
  } catch (e) {
    /* ignore */
  }

  // Confirmed convention (from a real URL the user gave me):
  //   https://www.propertyfinder.ae/en/buy/properties-for-sale.html?page=2&cq_src=...
  // Do not blindly manufacture page=N URLs: PropertyFinder can return a
  // blank shell past the final page. Prefer its next link, falling back to
  // URL generation only when the displayed result count proves another page exists.
  let nextPageUrl = null;
  const nextControl = document.querySelector(
    'a[rel="next"], a[aria-label*="next" i], a[data-testid*="next" i]'
  );
  const href = nextControl?.getAttribute("href");
  const disabled = nextControl?.getAttribute("aria-disabled") === "true" || nextControl?.hasAttribute("disabled");
  if (href && !disabled) {
    try { nextPageUrl = new URL(href, currentUrl).toString(); } catch (e) {}
  } else {
    const total = getResultsCount(document);
    const pageSize = collectListingLinks(document).length;
    if (Number.isFinite(total) && pageSize > 0 && total > currentPage * pageSize) {
      try {
        const u = new URL(currentUrl);
        u.searchParams.set("page", String(currentPage + 1));
        nextPageUrl = u.toString();
      } catch (e) {}
    }
  }
  return { currentPage, totalPages: null, nextPageUrl, mode: "numbered" };
}

export function extractListing(document, sourceUrl) {
  const listing = {};
  listing.source_url = sourceUrl;
  listing.source_site = siteName;
  listing.canonical_url = getCanonicalUrl() || sourceUrl;

  const og = getOpenGraph();
  listing.og_image = og.image;

  const jsonLdBlocks = [
    ...findJsonLdByType("Product"),
    ...findJsonLdByType("RealEstateListing"),
    ...findJsonLdByType("Residence"),
  ];
  listing.json_ld_present = jsonLdBlocks.length > 0;
  const ld = jsonLdBlocks[0] || {};

  listing.title = normalizeWhitespace(ld.name) || og.title || null;
  // PropertyFinder output is facts-only: descriptions are intentionally omitted.
  listing.description = null;

  // Deterministic first: the URL slug tells us purpose + property_type
  // directly, no page data needed at all.
  const fromUrl = parseUrlSlug(sourceUrl);
  if (fromUrl.property_type) listing.property_type = fromUrl.property_type;
  if (fromUrl.purpose) listing.purpose = fromUrl.purpose;

  const nextData = getNextData();
  let refNum = null;
  if (nextData) {
    const props = nextData.props?.pageProps || nextData.props || nextData;
    refNum = normalizeWhitespace(
      deepFind(props, ["referenceNumber", "reference"])
    );
    listing.bedrooms = normalizeBedrooms(deepFind(props, ["bedrooms", "rooms"]));
    listing.bathrooms = normalizeNumber(deepFind(props, ["bathrooms", "baths"]));
    const sizeRaw = deepFind(props, ["sizeSqft", "squareFeet", "areaSqft", "floorSize", "size", "area"]);
    listing.size_sqft = normalizeNumber(sizeRaw?.value ?? sizeRaw?.amount ?? sizeRaw);
    // NOTE: NOT searching a bare "type" key — that's what previously
    // produced the literal text "list" in property_type. "type" is common
    // enough in a big Next.js data tree that it matched an unrelated node
    // (a UI/list-item type flag) before ever reaching the real property
    // type field. Only fall back to __NEXT_DATA__ if the URL slug above
    // didn't already give us a clean answer.
    if (listing.property_type == null) {
      listing.property_type = normalizeWhitespace(
        deepFind(props, ["propertyType", "propertyTypeName", "category"])
      );
    }
    listing.agency = normalizeLabel(deepFind(props, ["agencyName", "brokerName", "agency"]));
    listing.agent_name = normalizeLabel(deepFind(props, ["agentName", "contactName"]));
    listing.developer = normalizeLabel(
      deepFind(props, ["developerName", "developer", "projectDeveloper"])
    );
    listing.community = normalizeLabel(deepFind(props, ["community", "locationName"]));
    listing.amenities = normalizeArray(deepFind(props, ["amenities", "features"]));
    listing.off_plan = normalizeBoolean(deepFind(props, ["offPlan", "isOffPlan"]));
    listing.furnished = normalizeBoolean(deepFind(props, ["furnished", "isFurnished"]));
    listing.parking = normalizeLabel(deepFind(props, ["parking", "parkingSpaces", "numberOfParkingSpaces"]));
    listing.floor = normalizeLabel(deepFind(props, ["floor", "floorNumber"]));

    let priceRaw = findListingPrice(props);
    if (ld.offers) {
      const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
      priceRaw = priceRaw ?? offer?.price;
    }
    setPurposePrice(listing, priceRaw);
  } else if (ld.offers) {
    const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
    const priceNum = normalizePrice(offer?.price);
    if (/rent/i.test(listing.purpose || "")) listing.annual_rent_aed = priceNum;
    else listing.price_aed = priceNum;
  }


  // Label-scan fallback for spec-sheet-style fields not reliably present
  // in JSON-LD/__NEXT_DATA__/description — same technique as the Bayut
  // parser. Best-effort: if these still come back null after a real
  // scrape, it means PropertyFinder renders that row differently than
  // guessed and the pattern needs a quick adjustment.
  // Size is exposed by Property Finder under several shapes (floorSize, area, or a labeled sqft row).
  if (listing.size_sqft == null) {
    const ldSize = ld.floorSize?.value ?? ld.floorSize?.amount ?? ld.floorSize;
    listing.size_sqft = normalizeNumber(ldSize);
  }
  if (listing.size_sqft == null && ld.description) {
    listing.size_sqft = parseDescriptionSpecs(ld.description).size_sqft ?? null;
  }
  if (listing.size_sqft == null) {
    const v = scanLabeledValue(document, [/^(?:built[- ]?up )?area$/i, /^size$/i, /sq\s*ft|sqft/i]);
    if (v) listing.size_sqft = normalizeNumber(v);
  }

  if (listing.BUA == null) {
    const v = scanLabeledValue(document, [/^BUA$/i, /built[\s-]?up\s*area/i]);
    if (v) listing.BUA = normalizeNumber(v);
  }
  if (listing.plot_size_sqft == null) {
    const v = scanLabeledValue(document, [/^plot\s*size$/i, /^plot\s*area$/i]);
    if (v) listing.plot_size_sqft = normalizeNumber(v);
  }
  if (listing.agency == null) {
    const v = scanLabeledValue(document, [/^agency$/i, /^broker$/i]);
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
  if (listing.price_aed == null && listing.annual_rent_aed == null) {
    const priceEl = document.querySelector('[aria-label*="Price" i], [class*="price" i]');
    if (priceEl) {
      setPurposePrice(listing, priceEl.textContent);
    }
  }

  listing.listing_id = makeListingId(sourceUrl, refNum);
  listing.date_collected = new Date().toISOString();
  listing.last_updated = listing.date_collected;
  return listing;
}

export function getPriceBounds(document) {
  const prices = extractSearchPageListings(document).map((item) => item.price).filter((price) => Number.isFinite(price) && price > 0);
  if (!prices.length) return null;
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

export function buildSortedPriceDescendingUrl(baseUrl) {
  const u = new URL(baseUrl);
  u.searchParams.set("ob", "pd"); // order-by: price-descending
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
          url = "https://www.propertyfinder.ae" + url;
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
    const cards = document.querySelectorAll(
      'a[data-testid*="property-card" i], a[class*="card-link" i], [class*="card-container" i], [data-testid="property-card"]'
    );
    cards.forEach((card) => {
      let href = card.getAttribute("href");
      if (!href) {
        const anchor = card.querySelector("a");
        if (anchor) href = anchor.getAttribute("href");
      }
      if (!href) return;
      if (href.startsWith("/")) href = "https://www.propertyfinder.ae" + href;
      try {
        const u = new URL(href);
        href = u.origin + u.pathname;
      } catch (e) {
        return;
      }
      if (seenUrls.has(href)) return;

      // Extract price from card text content
      const priceText = card.textContent || "";
      const priceMatch = priceText.replace(/,/g, "").match(/(?:AED|USD)\s*(\d+)/i) || priceText.replace(/,/g, "").match(/(\d+)\s*(?:AED|USD)/i);
      let price = null;
      if (priceMatch) {
        price = normalizeNumber(priceMatch[1]);
      } else {
        const cleanText = priceText.replace(/,/g, "");
        const numMatch = cleanText.match(/\b\d{5,12}\b/);
        if (numMatch) price = normalizeNumber(numMatch[0]);
      }

      if (href && Number.isFinite(price) && price > 0) {
        seenUrls.add(href);
        listings.push({ url: href, price });
      }
    });
  }

  return listings;
}
