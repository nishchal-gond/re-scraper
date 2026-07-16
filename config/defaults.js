// config/defaults.js
export const DEFAULT_SETTINGS = {
  startPage: 1,
  endPage: null, // null = go until last page detected
  maxPages: 50, // hard safety cap regardless of endPage, editable in Settings
  delayBetweenRequestsMs: 0, // per-listing throttle; lowered from 1500ms now that tabs are reused instead of recreated (see background/service-worker.js tab pool)
  fetchConcurrency: 30, // default concurrency for fetch pool
  concurrency: 8, // simultaneous listing tabs (tab pool concurrency)
  retryAttempts: 3,
  retryBackoffMs: 2000,
  exportFormat: "xlsx", // "xlsx" | "csv" | "json"
  outputFilename: "real_estate_scrape",
  overwriteExisting: false,
  appendExisting: true,
  enableImagesField: true,
  enableRawHtml: false, // off by default — see models/listing-schema.js note
  enableRawJsonExport: false,
  // (respectPageUnloadDelayMs removed — tabs are reused via a pool now,
  // not closed after every listing, so there's nothing to wait before.)

  // --- Automatic Dynamic Price Range Segmentation ---
  // (see background/service-worker.js computePriceRanges / autoSplitScrape)
  autoSplitListingThreshold: 900, // hard cap: no single price-band slice may return more than this many listings
  autoSplitPriceFloor: 0, // AED — used only if a parser's getPriceBounds() can't determine the search's real lowest price
  autoSplitPriceCeiling: 50000000, // AED — used only if getPriceBounds() can't determine the real highest price; raise if your market has pricier stock than this
  autoSplitMinRangeWidthAed: 1000, // stop narrowing a band tighter than this (AED) — prices are effectively never quoted below this granularity, so finer splitting just burns probes for no gain
  autoSplitProbeLimit: 400, // hard safety stop on total page-loads spent figuring out ranges, across the whole segmentation run
  autoSplitMaxDepth: 20, // safety stop on recursive splitting of a single saturated band (e.g. many listings at one exact price) so it can't loop forever
  segmentationSlices: 1, // one authoritative sequential segmentation cursor
  // --- Outlier / Solo-Listing Detection for Auto-Split ---
  // Listings whose price is more than this many times the sample median are
  // treated as genuine freak outliers and enqueued directly, NOT used as the
  // segmentation ceiling. A real freak is typically 10-50x the median; normal
  // top-end spread is 2-5x and must NOT be flagged. Default 8 is conservative.
  outlierMedianRatio: 8,
  // Hard cap on how many listings can ever be removed as outliers in one run.
  // If the detector would flag more than this, it's almost certainly wrong
  // (mis-parsed prices, per-sqft rates, etc.) — skip outlier removal instead.
  maxOutliersPerRun: 2,
  // After outlier removal, the segmentation ceiling is never allowed to fall
  // below this AED floor. If it would, outlier removal is skipped and a warning
  // is logged. Set to a value lower than your market's cheapest listing.
  minSegmentationCeiling: 300000, // AED 300K — safe default for Dubai residential
};

// Hard ceilings the UI will not let the user exceed, regardless of
// settings — this is what keeps "maximum speed" from becoming "the
// target site rate-limits or IP-bans the user's own browser."
export const HARD_LIMITS = {
  maxFetchConcurrency: 30, // Adaptive pool ceiling for fetch
  maxTabConcurrency: 10,   // Adaptive pool ceiling for tabs
  maxConcurrency: 100, // Increased from 30 to allow extreme speeds
  minDelayMs: 0, // Lowered from 500ms to allow zero delay
  maxPagesAbsolute: 500,
};

export const STORAGE_KEYS = {
  SETTINGS: "settings",
  SESSION: "session", // current scrape session state (for resume)
  LOGS: "logs",
};
