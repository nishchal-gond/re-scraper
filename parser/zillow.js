// parser/zillow.js
//
// STATUS: SCAFFOLD — NOT VERIFIED AGAINST LIVE DOM. Same caveat as
// propertyfinder.js: I couldn't render Zillow's JS in this sandbox.
//
// EXTRA WARNING SPECIFIC TO ZILLOW: Zillow's Terms of Use explicitly
// prohibit automated scraping/crawling of the site, and Zillow runs
// active bot detection (PerimeterX and similar). I've included this
// module purely because it was requested, but I'd strongly recommend
// checking Zillow's current ToS and using their official Bridge/RETS API
// data feeds for any real project involving Zillow data — scraping it
// against the ToS carries real legal/account risk that a scraper for a
// site without such a clause doesn't. This module also uses the
// US schema (price in USD, sqft, no Trakheesi/AED fields) rather than
// the AED/UAE fields — the field mapping below reuses the closest
// equivalents from the shared schema and leaves the rest null.

import {
  findJsonLdByType,
  getOpenGraph,
  getCanonicalUrl,
} from "../utils/structured-data.js";
import {
  normalizeWhitespace,
  normalizeNumber,
  normalizePrice,
  normalizeBedrooms,
  normalizeCoordinate,
} from "../utils/normalize.js";
import { makeListingId } from "../models/listing-schema.js";

export const siteName = "zillow";

export function matches(url) {
  return /(^https?:\/\/)?(www\.)?zillow\.com\//.test(url);
}

export function pageType(url) {
  if (/\/homedetails\//.test(url)) return "listing";
  if (/\/homes\/.*_rb\//.test(url) || /\/(sale|rent)\//.test(url)) return "search";
  return "unknown";
}

export function detectBlocker(document) {
  const bodyText = document.body ? document.body.innerText.slice(0, 2000) : "";
  return /press (&|and) hold|verify you are human|captcha|access to this page has been denied/i.test(
    bodyText
  );
}

export function collectListingLinks(document) {
  // PLACEHOLDER selector — verify against live markup before use.
  const seen = new Set();
  const results = [];
  const anchors = document.querySelectorAll('a[href*="/homedetails/"]');
  let position = 0;
  anchors.forEach((a) => {
    let href = a.getAttribute("href");
    if (!href) return;
    if (href.startsWith("/")) href = "https://www.zillow.com" + href;
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
  // Zillow's map-search UI is largely infinite-scroll / dynamic, not
  // numbered pages — flagging that honestly rather than pretending
  // ?page=N works reliably.
  let currentPage = 1;
  try {
    const u = new URL(currentUrl);
    const m = u.pathname.match(/(\d+)_p\//);
    if (m) currentPage = parseInt(m[1], 10);
  } catch (e) {
    /* ignore */
  }
  const nextLinkEl = document.querySelector('a[rel="next"], a[title="Next page" i]');
  let nextPageUrl = null;
  if (nextLinkEl && nextLinkEl.getAttribute("href")) {
    let href = nextLinkEl.getAttribute("href");
    if (href.startsWith("/")) href = "https://www.zillow.com" + href;
    nextPageUrl = href;
  }
  return {
    currentPage,
    totalPages: null,
    nextPageUrl,
    mode: nextPageUrl ? "numbered" : "infinite-scroll",
  };
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
    ...findJsonLdByType("SingleFamilyResidence"),
    ...findJsonLdByType("Residence"),
    ...findJsonLdByType("House"),
  ];
  listing.json_ld_present = jsonLdBlocks.length > 0;
  const ld = jsonLdBlocks[0] || {};

  listing.title = normalizeWhitespace(ld.name) || og.title || null;
  listing.description = normalizeWhitespace(ld.description) || og.description || null;
  if (ld.offers) {
    const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
    // Zillow prices are USD, not AED — stored in the same price_aed column
    // for schema consistency; treat as "listing currency" in this row.
    listing.price_aed = normalizePrice(offer?.price);
  }
  if (ld.numberOfRooms) listing.bedrooms = normalizeBedrooms(ld.numberOfRooms);
  if (ld.floorSize?.value) listing.size_sqft = normalizeNumber(ld.floorSize.value);

  listing.listing_id = makeListingId(sourceUrl, null);
  listing.date_collected = new Date().toISOString();
  listing.last_updated = listing.date_collected;
  return listing;
}

export function buildSortedPriceDescendingUrl(baseUrl) {
  const u = new URL(baseUrl);
  u.searchParams.set("sort", "price_desc"); // sort: price-descending
  return u.toString();
}

export function extractSearchPageListings(document) {
  const listings = [];
  const seenUrls = new Set();
  const anchors = document.querySelectorAll('a[href*="/homedetails/"]');
  anchors.forEach((a) => {
    let href = a.getAttribute("href");
    if (!href) return;
    if (href.startsWith("/")) href = "https://www.zillow.com" + href;
    try {
      const u = new URL(href);
      href = u.origin + u.pathname;
    } catch (e) {
      return;
    }
    if (seenUrls.has(href)) return;

    // Try finding price in sibling DOM tree
    let container = a.parentElement;
    let price = null;
    let depth = 0;
    while (container && depth < 4 && price === null) {
      const text = container.textContent || "";
      const priceMatch = text.replace(/,/g, "").match(/\$\s*([\d,]+)/);
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

  return listings;
}
