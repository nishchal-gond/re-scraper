// parser/parser-interface.js
//
// This is the contract every site parser module must implement. The core
// engine (content script + background orchestrator) never contains any
// site-specific selector or URL logic — it only calls these four methods.
// Adding a new site = writing one new module that implements this shape
// and registering it in parser/registry.js. Nothing else changes.
//
// Required exports on each parser module:
//
//   matches(url: string): boolean
//     True if this parser should handle the given page URL.
//
//   pageType(url: string): "search" | "listing" | "unknown"
//     Distinguishes a search-results page from an individual listing page.
//
//   collectListingLinks(document): { url: string, position: number }[]
//     Called on a search-results page. Returns every listing URL on the
//     current page, in DOM order, deduped, absolute (not relative).
//
//   detectPagination(document, currentUrl): {
//     currentPage: number,
//     totalPages: number | null,   // null if unknown (e.g. infinite scroll)
//     nextPageUrl: string | null,  // null if this is the last page
//     mode: "numbered" | "infinite-scroll" | "load-more"
//   }
//     Called on a search-results page.
//
//   extractListing(document, sourceUrl): object
//     Called on an individual listing page. Returns a partial listing
//     object (see models/listing-schema.js for the field list). Any field
//     the parser can't find MUST be omitted or set to null — never guessed.
//
// A parser may optionally export `siteName` (string) for logging/exports.
//
// Optional exports used by Automatic Dynamic Price Range Segmentation
// (see background/service-worker.js — computePriceRanges/autoSplitScrape):
//
//   getResultsCount(document): number | null
//     Total listing count for whatever filters are on the CURRENT page
//     (including any price band already applied in the URL). Returning
//     null is fine — the engine falls back to a slower probing method —
//     but implementing it makes segmentation dramatically cheaper (one
//     cheap page load per probe instead of paging deep to find out).
//
//   getPriceBounds(document): { min: number, max: number } | null
//     Best-effort true lowest/highest listing price for the current
//     (unfiltered) search, so segmentation can start from the real data
//     range instead of a configured guess. Null is fine; the engine
//     falls back to Settings (price floor/ceiling).
//
//   buildPriceFilteredUrl(baseUrl, minPrice, maxPrice): string
//     Returns a copy of baseUrl with a price filter of [minPrice,
//     maxPrice] applied (either bound may be null, meaning "no limit on
//     that side"), and any pagination state reset to page 1. Required
//     for a site to participate in auto-split at all — without it, the
//     "Auto-Split & Scrape" button reports the site isn't wired up yet.
