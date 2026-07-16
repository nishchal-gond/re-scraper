// background/service-worker.js
// MV3 service workers officially support ES module imports when the
// manifest declares "type": "module" for the background entry (unlike
// content scripts, which need bundling — see content-script.bundle.js).
//
// This is the orchestration engine. It owns:
//   - the scrape state machine (idle / running / paused / stopped / done)
//   - the tab lifecycle (opening/closing listing tabs, respecting concurrency)
//   - talking to the content script via chrome.tabs.sendMessage
//   - persisting progress continuously so a crashed browser/worker restart
//     can resume from the last successful listing, not from zero
//
// MV3 service workers get killed after ~30s of inactivity. A long scrape
// needs to survive that. We handle it two ways:
//   1. chrome.alarms ticks the engine loop back awake periodically.
//   2. All state that matters (queue, listings, current session config)
//      lives in IndexedDB/chrome.storage, not in worker memory, so a
//      fresh worker instance can pick up exactly where the last one left off.

import { db, enqueueUrls, upsertListing, markQueueStatus, incrementAttempts,
  getNextPendingUrls, getQueueStats, logEvent, getAllListings, clearAllData, claimPendingFetchUrls, claimPendingTabUrls } from "../storage/db.js";
import { getParserForUrl } from "../parser/registry.js";
import { tryFetchExtract } from "./fetch-extractor.js";
import { dedupeKey } from "../utils/normalize.js";
import { DEFAULT_SETTINGS, STORAGE_KEYS, HARD_LIMITS } from "../config/defaults.js";

// Active job trackers
const activeFetchJobs = new Set();
const activeTabJobs = new Set();

// Adaptive concurrency outcomes tracker (arrays of booleans: true for success, false for failure)
let fetchOutcomes = [];
let tabOutcomes = [];
let currentFetchConcurrency = null; // initialized dynamically
let currentTabConcurrency = null;   // initialized dynamically
let jobsSinceLastFetchAdjust = 0;
let jobsSinceLastTabAdjust = 0;

// Scrape method counters (acceptance check logs)
let fetchSuccessCount = 0;
let tabFallbackCount = 0;

const ALARM_NAME = "re_scraper_tick";
const SESSION_DEFAULT = {
  status: "idle", // idle | running | paused | stopped | done | blocked
  originTabId: null,
  originSearchUrl: null,
  currentPageNumber: 1,
  pagesProcessed: 0,
  totalPagesHint: null,
  successCount: 0,
  failCount: 0,
  retryCount: 0,
  startedAt: null,
  lastActivityAt: null,
  // Batch mode: a list of seed search URLs (e.g. the same search split
  // into several filtered slices — price bands, bedroom count, etc.) that
  // get walked one after another in the same session, without wiping
  // already-collected listings in between. This exists specifically for
  // sites like PropertyFinder that cap a single search's pagination depth
  // (e.g. ~50 pages / ~1,500 results) regardless of how many listings
  // actually match — narrower filters each stay under that cap, and the
  // per-listing dedupe (listing_id) means running several overlapping
  // slices back-to-back never produces duplicate rows.
  batchQueue: null, // string[] | null — null means "not a batch run"
  batchIndex: 0,
  batchTotal: 0,
  searchPageInProgress: false,
  autoSplitState: null, // persists auto-split progress
};

// A small pool of reused background tabs, sized to settings.concurrency.
// Reusing tabs (navigate via chrome.tabs.update) instead of creating and
// destroying a fresh tab per listing removes real per-listing overhead —
// tab process creation/teardown was costing several hundred ms to ~1s per
// listing for no benefit, since the tab's job is just "load a URL, read
// its DOM" and doesn't need process isolation between listings.
let tabPool = []; // [{ tabId, busy }]

// ---------- Settings / session persistence (chrome.storage.local) ----------

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };
}

async function setSettings(partial) {
  const current = await getSettings();
  const merged = clampSettings({ ...current, ...partial });
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}

function clampSettings(s) {
  return {
    ...s,
    concurrency: Math.min(Math.max(1, s.concurrency), HARD_LIMITS.maxTabConcurrency),
    fetchConcurrency: Math.min(Math.max(1, s.fetchConcurrency || 30), HARD_LIMITS.maxFetchConcurrency),
    delayBetweenRequestsMs: Math.max(HARD_LIMITS.minDelayMs, s.delayBetweenRequestsMs),
    maxPages: Math.min(s.maxPages, HARD_LIMITS.maxPagesAbsolute),
  };
}

async function getSession() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SESSION);
  return { ...SESSION_DEFAULT, ...(stored[STORAGE_KEYS.SESSION] || {}) };
}

async function setSession(partial) {
  const current = await getSession();
  const merged = { ...current, ...partial, lastActivityAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION]: merged });
  broadcastStatus(merged).catch(() => {});
  return merged;
}

async function broadcastStatus(session) {
  const stats = await getQueueStats();
  const listingCount = await db.listings.count();
  try {
    await chrome.runtime.sendMessage({
      type: "STATUS_UPDATE",
      session,
      queueStats: stats,
      listingCount,
    });
  } catch (e) {
    // No popup open to receive it — fine, it'll pull fresh state when opened.
  }
}

// ---------- Public message API (popup <-> background) ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleControlMessage(msg).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });
  return true;
});

async function handleControlMessage(msg) {
  switch (msg.type) {
    case "START_SCRAPE":
      return startScrape(msg.tabId, msg.url);
    case "START_BATCH_SCRAPE":
      return startBatchScrape(msg.tabId, msg.urls);
    case "AUTO_SPLIT_SCRAPE":
      return initAutoSplitScrape(msg.tabId, msg.url);
    case "PAUSE_SCRAPE":
      await setSession({ status: "paused" });
      await flushAllBuffers();
      await logEvent("info", "Scrape paused by user.");
      return { ok: true };
    case "RESUME_SCRAPE": {
      const currentSession = await getSession();
      if (currentSession.autoSplitState) {
        currentSession.autoSplitState.probesRun = 0;
        await setSession({ autoSplitState: currentSession.autoSplitState, status: "running" });
        await logEvent("info", "Scrape resumed — probe counter reset. Continuing auto-split segmentation.");
      } else {
        await setSession({ status: "running" });
        await logEvent("info", "Scrape resumed by user.");
      }
      ensureAlarm();
      runEngineTick();
      return { ok: true };
    }
    case "STOP_SCRAPE":
      await setSession({ status: "stopped" });
      await flushAllBuffers();
      await closeAllListingTabs();
      await closeAutoSplitTabs();
      await logEvent("info", "Scrape stopped by user.");
      return { ok: true };
    case "GET_STATUS": {
      const session = await getSession();
      const stats = await getQueueStats();
      const listingCount = await db.listings.count();
      const settings = await getSettings();
      return { ok: true, session, queueStats: stats, listingCount, settings };
    }
    case "GET_SETTINGS":
      return { ok: true, settings: await getSettings() };
    case "SET_SETTINGS":
      return { ok: true, settings: await setSettings(msg.settings) };
    case "CLEAR_DATA":
      await clearAllData();
      await flushAllBuffers();
      await setSession(SESSION_DEFAULT);
      return { ok: true };
    case "GET_ALL_LISTINGS":
      return { ok: true, listings: await getAllListings() };
    case "GET_RECENT_LOGS": {
      const logs = await db.eventLog.orderBy("timestamp").reverse().limit(msg.limit || 200).toArray();
      return { ok: true, logs };
    }
    default:
      return { ok: false, error: `Unknown control message: ${msg.type}` };
  }
}

// ---------- Scrape lifecycle ----------

async function startScrape(tabId, url) {
  const parser = getParserForUrl(url);
  if (!parser) {
    return { ok: false, error: "This page isn't a supported real estate site." };
  }
  if (parser.pageType(url) !== "search") {
    return {
      ok: false,
      error: "This doesn't look like a search-results page. Open a listings search page first.",
    };
  }

  const settings = await getSettings();
  const existing = await getSession();

  // TRUE RESUME: if the last session on this exact search URL was
  // interrupted (Stop, or a bot-check pause) partway through, and it had
  // already made progress, continue from exactly where it left off —
  // same page number, same still-pending queue of listing URLs — rather
  // than resetting to page 1. The queue/listings tables were never
  // cleared by Stop, only new page-walking was; this is what actually
  // makes that data useful instead of just re-collecting the same pages.
  //
  // Scoped to the same originSearchUrl on purpose: if the person opens a
  // genuinely different search (different filters/community), that's a
  // new scrape, not a continuation, even though old data is kept.
  const isResuming =
    (existing.status === "stopped" || existing.status === "blocked") &&
    existing.originSearchUrl === url &&
    existing.pagesProcessed > 0;

  if (isResuming) {
    await setSession({
      status: "running",
      originTabId: tabId, // refresh in case the old tab was closed/replaced
    });
    await logEvent(
      "info",
      `Resuming scrape from page ${existing.currentPageNumber} — picking the still-pending queue back up, not restarting from page 1.`
    );
    ensureAlarm();
    runEngineTick();
    return { ok: true, resumed: true };
  }

  await setSession({
    status: "running",
    originTabId: tabId,
    originSearchUrl: url,
    currentPageNumber: settings.startPage,
    pagesProcessed: 0,
    successCount: 0,
    failCount: 0,
    retryCount: 0,
    startedAt: Date.now(),
    autoSplitState: null,
    batchQueue: null,
  });
  await logEvent("info", `Scrape started at ${url}`);
  ensureAlarm();
  runEngineTick();
  return { ok: true };
}

// ---------------------------------------------------------------------
// Automatic Dynamic Price Range Segmentation
// ---------------------------------------------------------------------
// One-click: takes a single search URL (whatever filters — location,
// property type, bedrooms — are already on it, no price range applied)
// and guarantees every matching listing gets extracted, even when the
// search has far more results than a single query can page through.
//
//   1. Probe the ORIGINAL, unfiltered search for its total listing count.
//   2. If that's already at or under the configured threshold (default
//      900), no split is needed — hand off to a normal single-URL scrape.
//   3. Otherwise, walk the price axis from the search's real lowest price
//      to its real highest price (parser.getPriceBounds, when a site
//      implements it; configured floor/ceiling otherwise), carving off
//      the WIDEST possible [lo, hi] band at each step such that the
//      band's own probed count stays at or under the threshold.
//   4. Each accepted band becomes one seed URL, handed to the same batch
//      engine (startBatchScrape) that walks several seed URLs into one
//      deduped dataset (dedupe is by listing_id, applied on every
//      upsert — see storage/db.js).
//
// No fixed AED increment is ever used. Band width is decided entirely by
// live probes (parser.getResultsCount — one cheap page load per probe):
// exponential growth finds a rough upper bound quickly, then binary
// search tightens it down to autoSplitMinRangeWidthAed. A band that came
// back comfortably under the threshold makes the NEXT band's starting
// guess wider (sparse stretch of the price axis); a band that needed
// heavy narrowing keeps the next guess similar (dense stretch) — this is
// what makes ranges "as large as possible" instead of a fixed grid.
//
// A single exact price shared by more listings than the threshold can't
async function initAutoSplitScrape(tabId, url) {
  // A slice always starts at page 1; never inherit the page the user happened to open.
  try { const normalized = new URL(url); normalized.searchParams.delete("page"); url = normalized.toString(); } catch (e) {}
  // --- TRUE BATCH RESUME (checked FIRST, before page-type validation) ---
  const existing = await getSession();
  const wasBatchRun = Array.isArray(existing.batchQueue) && existing.batchQueue.length > 0;
  const wasInterrupted = ["stopped", "blocked"].includes(existing.status);  // Recover a legacy filtered first slice when no saved queue exists.
  let resumeSeedSlice = null;
  let resumeFloor = null;
  if (!wasBatchRun && ["stopped", "done"].includes(existing.status)) {
    try {
      const parsed = new URL(url);
      const upper = Number(parsed.searchParams.get("pt") || parsed.searchParams.get("price_max"));
      const lower = Number(parsed.searchParams.get("pf") || parsed.searchParams.get("price_min"));
      if (Number.isFinite(lower) && Number.isFinite(upper) && upper >= lower) {
        resumeSeedSlice = url;
        resumeFloor = upper + 1;
        parsed.searchParams.delete("pf"); parsed.searchParams.delete("pt");
        parsed.searchParams.delete("price_min"); parsed.searchParams.delete("price_max"); parsed.searchParams.delete("page");
        url = parsed.toString();
        await logEvent("info", `Previous filtered slice detected (${lower.toLocaleString()}–${upper.toLocaleString()} AED). Keeping it and generating the remaining slices from AED ${resumeFloor.toLocaleString()}.`);
      }
    } catch { /* normal auto-split fallback */ }
  }  // Resume a saved auto-split queue instead of treating a completed filtered
  // URL as a brand-new search (which used to restart slice 1 forever).
  if (wasBatchRun && ["stopped", "blocked", "done"].includes(existing.status)) {
    const normalizeSearchUrl = (value) => {
      try {
        const parsed = new URL(value);
        parsed.searchParams.delete("page");
        return parsed.toString();
      } catch { return String(value || ""); }
    };
    const inputKey = normalizeSearchUrl(url);
    const matchedIndex = existing.batchQueue.findIndex((candidate) => normalizeSearchUrl(candidate) === inputKey);
    let nextIndex = matchedIndex >= 0 ? matchedIndex : existing.batchIndex;
    const resumingCurrent = wasInterrupted && matchedIndex >= 0 && matchedIndex === existing.batchIndex && existing.pagesProcessed > 0;
    if (!resumingCurrent && matchedIndex >= 0 && matchedIndex < existing.batchIndex) nextIndex = matchedIndex + 1;
    if (!resumingCurrent && existing.status === "done" && matchedIndex >= 0) nextIndex = matchedIndex + 1;

    if (nextIndex < existing.batchQueue.length) {
      const nextUrl = existing.batchQueue[nextIndex];
      await setSession({
        status: "running", originTabId: tabId, originSearchUrl: nextUrl,
        currentPageNumber: resumingCurrent ? existing.currentPageNumber : 1,
        pagesProcessed: resumingCurrent ? existing.pagesProcessed : 0,
        nextPageUrl: resumingCurrent ? existing.nextPageUrl : null,
        totalPagesHint: resumingCurrent ? existing.totalPagesHint : null,
        batchIndex: nextIndex, autoSplitState: null,
      });
      try {
        await chrome.tabs.update(tabId, { url: nextUrl });
        await waitForTabLoad(tabId);
      } catch (err) {
        const replacement = await chrome.tabs.create({ url: nextUrl, active: false });
        await waitForTabLoad(replacement.id);
        await setSession({ originTabId: replacement.id });
      }
      await logEvent("info", `${resumingCurrent ? "Resuming" : "Continuing"} saved auto-split slice ${nextIndex + 1}/${existing.batchQueue.length}: ${nextUrl}`);
      ensureAlarm();
      runEngineTick();
      return { ok: true, resumed: true, slice: nextIndex + 1 };
    }
    await logEvent("info", "All saved auto-split slices are already complete; nothing to restart.");
    return { ok: false, error: "All saved auto-split slices are already complete." };
  }

  if (wasInterrupted && wasBatchRun && existing.pagesProcessed > 0) {
    const savedUrl = existing.originSearchUrl || existing.batchQueue?.[existing.batchIndex];
    let sameSite = false;
    try {
      sameSite = savedUrl && new URL(savedUrl).hostname === new URL(url).hostname;
    } catch { /* ignore */ }

    if (sameSite) {
      const resumeUrl = existing.originSearchUrl;
      await setSession({
        status: "running",
        originTabId: tabId,
      });
      const sliceNum = existing.batchIndex + 1;
      const totalSlices = existing.batchTotal || existing.batchQueue.length;

      try {
        await chrome.tabs.update(tabId, { url: resumeUrl });
        await waitForTabLoad(tabId);
      } catch (err) {
        await logEvent("warn", `Could not navigate to saved URL, creating new tab…`);
        try {
          const newTab = await chrome.tabs.create({ url: resumeUrl, active: false });
          await waitForTabLoad(newTab.id);
          await setSession({ originTabId: newTab.id });
        } catch (retryErr) {
          await logEvent("error", `Failed to create tab for resume: ${retryErr.message}`);
          await setSession({ status: "stopped" });
          return { ok: false, error: retryErr.message };
        }
      }

      await logEvent(
        "info",
        `Resuming auto-split batch from slice ${sliceNum}/${totalSlices}, page ${existing.currentPageNumber} — not re-probing price ranges.`
      );
      ensureAlarm();
      runEngineTick();
      return { ok: true, resumed: true };
    }
  }

  const parser = getParserForUrl(url);
  if (!parser) return { ok: false, error: "This page isn't a supported real estate site." };
  if (parser.pageType(url) !== "search") {
    return { ok: false, error: "Open a search-results page first, then click Auto-Split & Scrape." };
  }
  if (!parser.buildPriceFilteredUrl) {
    return {
      ok: false,
      error: "Auto-split isn't wired up for this site yet — use Batch mode with manually filtered URLs instead.",
    };
  }

  await setSession({
    status: "running",
    originTabId: tabId,
    originSearchUrl: null,
    currentPageNumber: 1,
    pagesProcessed: 0,
    successCount: 0,
    failCount: 0,
    retryCount: 0,
    startedAt: Date.now(),
    batchQueue: resumeSeedSlice ? [resumeSeedSlice] : [],
    batchIndex: resumeSeedSlice ? 1 : 0,
    batchTotal: 0,
    searchPageInProgress: false,
    autoSplitState: {
      baseUrl: url,
      resumeFloor,
      floor: null,
      ceiling: null,
      scratchTabs: [],
      cursors: null,
      initialProbed: false,
      probesRun: 0,
      outliersChecked: false
    }
  });

  await logEvent("info", `Auto-split initialized for ${url}. Range generation and scraping will run concurrently.`);
  ensureAlarm();
  runEngineTick();
  return { ok: true };
}

async function runAutoSplitStep(session) {
  const state = session.autoSplitState;
  const baseUrl = state.baseUrl;
  const parser = getParserForUrl(baseUrl);
  const settings = await getSettings();
  const threshold = settings.autoSplitListingThreshold;
  const minWidth = Math.max(1, settings.autoSplitMinRangeWidthAed || 1);
  const probeLimit = settings.autoSplitProbeLimit;

  // 1. Initial Probe Phase to find Floor and Ceiling
  if (!state.initialProbed) {
    let scratchTabId = state.scratchTabs[0];
    if (scratchTabId == null) {
      try {
        const scratchTab = await chrome.tabs.create({ url: baseUrl, active: false });
        scratchTabId = scratchTab.id;
        state.scratchTabs[0] = scratchTabId;
        await setSession({ autoSplitState: state });
      } catch (e) {
        await logEvent("error", `Auto-split: failed to create initial scratch tab: ${e.message}`);
        await setSession({ status: "paused" });
        return;
      }
    }

    await logEvent("info", `Auto-split: checking total listing count for ${baseUrl}`);
    try {
      state.probesRun += 1;
      await setSession({ autoSplitState: state });
      await chrome.tabs.update(scratchTabId, { url: baseUrl });
      await waitForTabLoad(scratchTabId);
      const totalResp = await safeSendMessage(scratchTabId, { type: "GET_RESULTS_COUNT" });
      const totalCount = totalResp?.ok ? totalResp.count : null;

      if (totalCount != null && totalCount <= threshold) {
        await logEvent("info", `Auto-split: total is ${totalCount} listings, already at or under the ${threshold} cap — no split needed, extracting directly.`);
        try { await chrome.tabs.remove(scratchTabId); } catch (e) {}
        await setSession({ autoSplitState: null });
        await startScrape(session.originTabId, baseUrl);
        return;
      }

      // 1.1 Outlier Detection Phase
      // Strategy: compare each candidate against the sample MEDIAN, not its
      // immediate neighbor. Consecutive-pair gaps are too sensitive to natural
      // price spread at the sparse top end of a real market sample, causing
      // cascading false positives (see bug report). The median is stable and
      // represents the "bulk of the distribution" regardless of how many top-end
      // listings happen to appear in the sample.
      let outlierCeiling = null;
      if (!state.outliersChecked && parser.buildSortedPriceDescendingUrl && parser.extractSearchPageListings) {
        try {
          const descUrl = parser.buildSortedPriceDescendingUrl(baseUrl);
          await logEvent("info", `Auto-split: checking for price outliers using sorted descending URL: ${descUrl}`);

          await chrome.tabs.update(scratchTabId, { url: descUrl });
          await waitForTabLoad(scratchTabId);
          await sleep(1000);

          const listingsResp = await safeSendMessage(scratchTabId, { type: "EXTRACT_SEARCH_LISTINGS" });
          const rawListings = listingsResp?.ok ? listingsResp.listings : [];
          const allPrices = (rawListings || [])
            .map(l => l.price)
            .filter(p => Number.isFinite(p) && p > 0);

          if (allPrices.length > 1) {
            // Compute the sample median for a stable baseline
            const sorted = [...allPrices].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            const median = sorted.length % 2 === 0
              ? (sorted[mid - 1] + sorted[mid]) / 2
              : sorted[mid];

            const medianRatio = settings.outlierMedianRatio || 8;
            const maxOutliers = settings.maxOutliersPerRun || 2;
            const minCeiling = settings.minSegmentationCeiling || 300000;

            // Sort the full listings descending by price for evaluation
            const listings = [...(rawListings || [])]
              .filter(l => Number.isFinite(l.price) && l.price > 0)
              .sort((a, b) => b.price - a.price);

            // Identify genuine outliers: price / median > threshold
            const candidateOutliers = listings.filter(l => l.price / median > medianRatio);

            // Sanity check: if > 15% of sample is flagged, something is wrong upstream
            const flaggedPct = candidateOutliers.length / listings.length;
            if (flaggedPct > 0.15) {
              await logEvent("warn",
                `Auto-split: outlier detection flagged ${candidateOutliers.length}/${listings.length} (${Math.round(flaggedPct * 100)}%) of the sample — ` +
                `check price parsing for ${parser.siteName || "this site"}. Skipping outlier removal.`
              );
            } else if (candidateOutliers.length > maxOutliers) {
              // More than the per-run cap — almost certainly misbehaving
              await logEvent("warn",
                `Auto-split: outlier detection found ${candidateOutliers.length} candidates but cap is ${maxOutliers}. ` +
                `Skipping outlier removal to avoid mislabeling real listings.`
              );
            } else if (candidateOutliers.length > 0) {
              // Compute what the new ceiling would be (highest non-outlier price)
              const nonOutliers = listings.filter(l => l.price / median <= medianRatio);
              const proposedCeiling = nonOutliers.length > 0 ? nonOutliers[0].price : null;

              if (proposedCeiling === null || proposedCeiling < minCeiling) {
                await logEvent("warn",
                  `Auto-split: outlier removal would set ceiling to AED ${(proposedCeiling || 0).toLocaleString()} ` +
                  `which is below minSegmentationCeiling (AED ${minCeiling.toLocaleString()}). ` +
                  `Skipping outlier removal — check price parsing.`
                );
              } else {
                // All checks passed — safe to remove outliers
                await logEvent("info",
                  `Auto-split: detected ${candidateOutliers.length} price outlier(s) ` +
                  `(ratio > ${medianRatio}x median of AED ${Math.round(median).toLocaleString()}).`
                );
                const enqueueList = candidateOutliers.map(item => ({
                  url: item.url,
                  site: parser.siteName || "unknown",
                  source: "outlier-direct"
                }));
                const addedCount = await enqueueUrls(enqueueList);
                await logEvent("info", `Auto-split: enqueued ${addedCount} outlier listing(s) directly into queue.`);
                for (const item of candidateOutliers) {
                  await logEvent("info",
                    `Auto-split outlier: enqueued direct seed ${item.url} at AED ${item.price.toLocaleString()} ` +
                    `(${(item.price / median).toFixed(1)}x median)`
                  );
                }
                outlierCeiling = proposedCeiling;
                await logEvent("info",
                  `Auto-split: capping segmentation ceiling at AED ${outlierCeiling.toLocaleString()} ` +
                  `(was AED ${listings[0].price.toLocaleString()})`
                );
              }
            } else {
              await logEvent("info", `Auto-split: no price outliers detected (median AED ${Math.round(median).toLocaleString()}, ratio threshold ${medianRatio}x).`);
            }
          }
        } catch (err) {
          await logEvent("warn", `Auto-split outlier check warning: ${err.message || err}`);
        } finally {
          state.outliersChecked = true;
          await setSession({ autoSplitState: state });
        }
      }

      let floor = state.resumeFloor || settings.autoSplitPriceFloor;
      let ceiling = settings.autoSplitPriceCeiling;

      let parsedMin = null;
      let parsedMax = null;
      try {
        const uObj = new URL(baseUrl);
        const pf = uObj.searchParams.get("pf") || uObj.searchParams.get("price_min");
        const pt = uObj.searchParams.get("pt") || uObj.searchParams.get("price_max");
        if (pf && !isNaN(Number(pf))) parsedMin = Number(pf);
        if (pt && !isNaN(Number(pt))) parsedMax = Number(pt);
      } catch (e) {}

      let bounds = null;
      if ((parsedMin === null || parsedMax === null) && parser.getPriceBounds && outlierCeiling === null) {
        const boundsResp = await safeSendMessage(scratchTabId, { type: "GET_PRICE_BOUNDS" });
        bounds = boundsResp?.ok ? boundsResp.bounds : null;
      }

      if (state.resumeFloor) {
        floor = state.resumeFloor;
      } else if (parsedMin !== null) {
        floor = parsedMin;
      } else if (Number.isFinite(Number(settings.autoSplitPriceFloor)) && Number(settings.autoSplitPriceFloor) > 0) {
        // A configured floor is authoritative; detected bounds may only raise it.
        floor = Math.max(Number(settings.autoSplitPriceFloor), bounds?.min || 0);
      } else if (bounds && Number.isFinite(bounds.min)) {
        floor = bounds.min;
      }

      if (parsedMax !== null) {
        ceiling = parsedMax;
      } else if (Number.isFinite(Number(settings.autoSplitPriceCeiling)) && Number(settings.autoSplitPriceCeiling) > 0) {
        // A configured ceiling is authoritative; do not replace it with a sample max.
        ceiling = Number(settings.autoSplitPriceCeiling);
      } else if (outlierCeiling !== null) {
        ceiling = outlierCeiling;
      } else if (bounds && Number.isFinite(bounds.max) && bounds.max > floor) {
        ceiling = bounds.max;
      }

      state.floor = floor;
      state.ceiling = ceiling;
      await logEvent("info", `Auto-split effective price range: AED ${floor.toLocaleString()}–${ceiling.toLocaleString()}.`);

      try { await chrome.tabs.remove(scratchTabId); } catch (e) {}
      state.scratchTabs = [];

      // Partition the range log-scaled across parallel cursors
      const numSlices = 1; // single authoritative splitter; ranges are generated sequentially
      const cursors = [];
      const logFloor = Math.log(Math.max(1, floor));
      const logCeiling = Math.log(Math.max(2, ceiling));
      const step = (logCeiling - logFloor) / numSlices;
      
      for (let i = 0; i < numSlices; i++) {
        const sliceLo = i === 0 ? floor : Math.round(Math.exp(logFloor + i * step)) + 1;
        const sliceHi = i === numSlices - 1 ? ceiling : Math.round(Math.exp(logFloor + (i + 1) * step));
        cursors.push({
          lo: sliceLo,
          hi: sliceHi,
          currentLo: sliceLo,
          nextStartWidth: Math.max(minWidth, Math.floor((sliceHi - sliceLo) / 20) || minWidth),
          probesRun: 0,
          done: false
        });
      }
      state.cursors = cursors;
      state.initialProbed = true;
      await setSession({ autoSplitState: state });
      return;
    } catch (e) {
      await logEvent("error", `Auto-split initial probe failed: ${e.message}`);
      await setSession({ status: "paused" });
      return;
    }
  }

  // 2. Active Cursor Stepping Phase  // Queue each unfinished remainder once when the global probe safety cap is reached.
  if (state.probesRun >= probeLimit) {
    for (const cursor of state.cursors || []) {
      if (cursor.done || cursor.currentLo > cursor.hi) continue;
      const remainingUrl = parser.buildPriceFilteredUrl(baseUrl, cursor.currentLo, cursor.hi);
      const current = await getSession();
      if (!current.batchQueue.includes(remainingUrl)) {
        current.batchQueue.push(remainingUrl);
        await setSession({ batchQueue: current.batchQueue, batchTotal: current.batchQueue.length });
      }
      cursor.done = true;
    }
    await logEvent("warn", `Auto-split probe limit (${probeLimit}) reached; queued remaining ranges and continuing.`);
  }
  const activeCursors = state.cursors.filter((c) => !c.done);
  if (activeCursors.length === 0) {
    await logEvent("info", "Auto-split complete: All cursors finished range segmentation; queued slices will continue extracting.");
    for (const tabId of state.scratchTabs) {
      if (tabId) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
    }
    const generated = await getSession();
    const startIndex = generated.batchIndex || 0;
    const firstSlice = Array.isArray(generated.batchQueue) ? generated.batchQueue[startIndex] : null;
    const pipelineAlreadyStarted = !!generated.originSearchUrl || generated.pagesProcessed > 0 || generated.searchPageInProgress;
    if (pipelineAlreadyStarted) {
      await setSession({ autoSplitState: null });
    } else {
      await setSession({ autoSplitState: null, originSearchUrl: firstSlice || generated.originSearchUrl, batchIndex: startIndex, currentPageNumber: 1, pagesProcessed: 0, nextPageUrl: null, totalPagesHint: null });
    }
    if (firstSlice) await logEvent("info", `Auto-split generated ${generated.batchQueue.length} slice(s). ${pipelineAlreadyStarted ? "Continuing the active pipeline" : `Starting slice ${startIndex + 1}`}: ${firstSlice}`);
    return;
  }

  // Ensure scratch tab exists for each cursor index
  for (let i = 0; i < state.cursors.length; i++) {
    const cursor = state.cursors[i];
    if (!cursor.done && state.scratchTabs[i] == null) {
      try {
        const scratchTab = await chrome.tabs.create({ url: baseUrl, active: false });
        state.scratchTabs[i] = scratchTab.id;
      } catch (e) {
        await logEvent("error", `Auto-split: failed to create scratch tab for cursor ${i + 1}: ${e.message}`);
        await setSession({ status: "paused" });
        return;
      }
    }
  }

  async function runCursorStep(cursor, index) {
    if (cursor.retryAt && Date.now() < cursor.retryAt) return;
    cursor.retryAt = 0;
    const scratchTabId = state.scratchTabs[index];
    if (!scratchTabId) return;

    async function probeCount(loPrice, hiPrice) {
      const currentSession = await getSession();
      if (currentSession.status !== "running") throw new Error("Scrape stopped.");
      const url = parser.buildPriceFilteredUrl(baseUrl, loPrice, hiPrice);
      cursor.probesRun += 1;
      state.probesRun += 1;
      await setSession({ autoSplitState: state });
      await logEvent("info", `Auto-split cursor ${index + 1}: probing range ${loPrice}–${hiPrice} AED (Probe #${cursor.probesRun})...`);
      await chrome.tabs.update(scratchTabId, { url });
      await waitForTabLoad(scratchTabId);
      
      let attempts = 0;
      while (attempts < 6) {
        const resp = await safeSendMessage(scratchTabId, { type: "GET_RESULTS_COUNT" });
        if (resp?.ok && resp.count !== null) {
          return { url, count: resp.count };
        }
        attempts++;
        if (attempts < 6) await sleep(1000);
      }
      return { url, count: null };
    }

    async function widestSafeBand(loVal, startWidth) {
      const solo = await probeCount(loVal, loVal);
      if (solo.count === null) throw new Error(`Failed to read count for price point ${loVal} AED.`);
      if (solo.count > threshold) {
        await logEvent("warn", `Auto-split cursor ${index + 1}: ${solo.count} listings at exact price ${loVal} AED, keeping as one slice.`);
        return { hi: loVal, count: solo.count, url: solo.url };
      }
      let validHi = loVal, validCount = solo.count, validUrl = solo.url;
      let invalidHi = null;
      let width = Math.max(startWidth, minWidth);
      let candidate = Math.min(cursor.hi, loVal + width);

      while (state.probesRun < probeLimit) {
        const { url, count } = await probeCount(loVal, candidate);
        if (count === null) throw new Error("Count probe failed.");
        if (count > threshold) {
          invalidHi = candidate;
          break;
        }
        validHi = candidate;
        validCount = count;
        validUrl = url;
        if (candidate >= cursor.hi) return { hi: cursor.hi, count, url };
        width *= 2;
        candidate = Math.min(cursor.hi, loVal + width);
      }

      if (invalidHi === null) return { hi: validHi, count: validCount, url: validUrl };

      let lowSafe = validHi, highUnsafe = invalidHi;
      let bestCount = validCount, bestUrl = validUrl;
      while (highUnsafe - lowSafe > minWidth && state.probesRun < probeLimit) {
        const mid = Math.floor((lowSafe + highUnsafe) / 2);
        const { url, count } = await probeCount(loVal, mid);
        if (count === null) throw new Error("Count probe failed.");
        if (count <= threshold) {
          lowSafe = mid;
          bestCount = count;
          bestUrl = url;
        } else {
          highUnsafe = mid;
        }
      }
      return { hi: lowSafe, count: bestCount, url: bestUrl };
    }

    if (cursor.currentLo <= cursor.hi && state.probesRun < probeLimit) {
      try {
        const band = await widestSafeBand(cursor.currentLo, cursor.nextStartWidth);
        if (band.count === 0) {
          cursor.currentLo = band.hi + 1;
          cursor.nextStartWidth = Math.max(minWidth, cursor.nextStartWidth * 2);
        } else {
          await logEvent("info", `Auto-split cursor ${index + 1}: queued slice ${cursor.currentLo}–${band.hi} AED (${band.count} listings).`);
          const widthUsed = Math.max(minWidth, band.hi - cursor.currentLo);
          cursor.nextStartWidth = band.count < threshold * 0.5 ? widthUsed * 2 : widthUsed;
          cursor.currentLo = band.hi + 1;
          
          const sessionUpdate = await getSession();
          const duplicateRange = sessionUpdate.batchQueue.includes(band.url);
          if (!duplicateRange) {
            sessionUpdate.batchQueue.push(band.url);
            sessionUpdate.batchTotal = sessionUpdate.batchQueue.length;
          } else {
            await logEvent("warn", `Auto-split cursor ${index + 1}: skipping duplicate range ${band.url}.`);
          }
          if (!sessionUpdate.originSearchUrl) {
            sessionUpdate.originSearchUrl = band.url;
            sessionUpdate.currentPageNumber = 1;
            sessionUpdate.pagesProcessed = 0;
          }
          await setSession({
            batchQueue: sessionUpdate.batchQueue,
            batchTotal: sessionUpdate.batchTotal,
            originSearchUrl: sessionUpdate.originSearchUrl,
          });
        }
      } catch (err) {
        await logEvent("error", `Auto-split cursor ${index + 1} step failed: ${err.message}`);
        if (/Count probe failed|Failed to read count|No tab with id|Could not establish connection/i.test(err.message || "")) {
          cursor.retryAt = Date.now() + 5000;
          await logEvent("warn", `Auto-split cursor ${index + 1}: retaining its range and retrying the count probe.`);
        } else {
          cursor.done = true;
        }
      }
    }

    if (cursor.currentLo > cursor.hi) {
      cursor.done = true;
      await logEvent("info", `Auto-split cursor ${index + 1} finished sub-range ${cursor.lo}–${cursor.hi} AED.`);
      if (scratchTabId) {
        try { await chrome.tabs.remove(scratchTabId); } catch (e) {}
        state.scratchTabs[index] = null;
      }
    }
  }

  await Promise.all(
    state.cursors.map((cursor, idx) => {
      if (!cursor.done) return runCursorStep(cursor, idx);
      return Promise.resolve();
    })
  );

  await setSession({ autoSplitState: state });
}
// Start a batch run over several seed search URLs, one after another.
// Each URL should be a *narrower* slice of the same overall search (e.g.
// split by price band, bedroom count, or subcommunity) so that no single
// slice hits the site's own pagination-depth cap. Already-collected
// listings are never cleared between slices, and per-listing dedupe
// (listing_id, keyed off the canonical listing URL) means overlapping
// slices just skip re-adding the same property rather than duplicating it.
async function startBatchScrape(tabId, urls) {
  const cleaned = (urls || [])
    .map((u) => (u || "").trim())
    .filter(Boolean);
  if (!cleaned.length) {
    return { ok: false, error: "No seed URLs provided." };
  }
  for (const u of cleaned) {
    const parser = getParserForUrl(u);
    if (!parser) {
      return { ok: false, error: `Not a supported site URL: ${u}` };
    }
    if (parser.pageType(u) !== "search") {
      return { ok: false, error: `Not a search-results URL: ${u}` };
    }
  }

  const settings = await getSettings();
  await setSession({
    status: "running",
    originTabId: tabId,
    originSearchUrl: cleaned[0],
    currentPageNumber: settings.startPage,
    pagesProcessed: 0,
    successCount: 0,
    failCount: 0,
    retryCount: 0,
    startedAt: Date.now(),
    batchQueue: cleaned,
    batchIndex: 0,
    batchTotal: cleaned.length,
  });
  await logEvent(
    "info",
    `Batch scrape started: ${cleaned.length} seed URL(s). Slice 1/${cleaned.length}: ${cleaned[0]}`
  );
  ensureAlarm();
  runEngineTick();
  return { ok: true };
}

// Central "this search is exhausted" handler. In a normal single-URL run
// this just marks the session done. In batch mode, it advances to the
// next seed URL (if any) and keeps running instead of stopping — that's
// the whole mechanism that gets around a per-search pagination cap.
async function finishCurrentSearch(session, reason) {
  await setSession({ searchPageInProgress: false });
  const inBatch = Array.isArray(session.batchQueue) && session.batchQueue.length > 0;
  const nextIndex = session.batchIndex + 1;

  if (inBatch) {
    if (nextIndex < session.batchQueue.length) {
      const nextUrl = session.batchQueue[nextIndex];
      await logEvent(
        "info",
        `Slice ${session.batchIndex + 1}/${session.batchTotal} finished (${reason}). Moving to slice ${nextIndex + 1}/${session.batchTotal}: ${nextUrl}`
      );
      await setSession({
        status: "running",
        originSearchUrl: nextUrl,
        currentPageNumber: 1,
        pagesProcessed: 0,
        nextPageUrl: null,
        totalPagesHint: null,
        batchIndex: nextIndex,
      });
      try {
        await chrome.tabs.update(session.originTabId, { url: nextUrl });
        await waitForTabLoad(session.originTabId);
      } catch (err) {
        // Tab was closed/crashed — create a replacement tab instead of stopping
        await logEvent("warn", `Origin tab lost between slices (${err.message}). Creating a replacement tab…`);
        try {
          const newTab = await chrome.tabs.create({ url: nextUrl, active: false });
          await waitForTabLoad(newTab.id);
          await setSession({ originTabId: newTab.id });
          session.originTabId = newTab.id;
        } catch (retryErr) {
          await logEvent("error", `Failed to recover with a new tab: ${retryErr.message}. Stopping.`);
          await setSession({ status: "stopped" });
          return;
        }
      }
      runEngineTick();
      return;
    } else if (session.autoSplitState) {
      // Exhausted current queue, but auto-split is still running. Pause search processing for now.
      return;
    }
  }

  await setSession({ status: "done" });
  await logEvent(
    "info",
    inBatch
      ? `Batch scrape complete — all ${session.batchTotal} slice(s) processed (${reason}).`
      : `Scrape complete (${reason}).`
  );
}

function ensureAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 }); // ~24s, keeps worker alive
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runEngineTick();
});

// The engine is idempotent and re-entrant-safe: calling it repeatedly while
// it's already working just no-ops on the in-flight parts, which is exactly
// what we want given service worker wake/sleep cycles.
let tickRunning = false;
async function runEngineTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const session = await getSession();
    if (session.status !== "running") return;

    const tasks = [];
    if (session.autoSplitState) {
      tasks.push(runAutoSplitStep(session));
    }
    
    // Refresh session to get updates from auto-split step
    const refreshedSession = await getSession();
    if (refreshedSession.status === "running") {
      const inBatch = Array.isArray(refreshedSession.batchQueue) && refreshedSession.batchQueue.length > 0;
      // Pipeline mode: scrape each queued slice while probing continues.
      // Only one slice collector runs at a time; listing extraction remains concurrent.
      if (refreshedSession.originSearchUrl) {
        const settings = await getSettings();
        const stats = await getQueueStats();

        // Queue empty and no page currently being processed for links -> move
        // to next search page, or finish.
        if (stats.pending === 0 && stats.inProgress === 0 && activeFetchJobs.size === 0 && activeTabJobs.size === 0) {
          tasks.push(advanceToNextPageOrFinish(refreshedSession, settings));
        } else {
          tasks.push(drainQueue(refreshedSession, settings));
        }
      }
    }
    
    await Promise.all(tasks);
    
    const finalSession = await getSession();
    // If auto-split is still running or active jobs exist, trigger next tick quickly
    if (finalSession.status === "running" && (finalSession.autoSplitState || activeFetchJobs.size > 0 || activeTabJobs.size > 0)) {
      setTimeout(runEngineTick, 100);
    }
  } catch (err) {
    if (!err.message.includes("Tabs cannot be edited right now")) {
      await logEvent("error", `Engine tick error: ${err.message}`);
    }
  } finally {
    tickRunning = false;
  }
}

async function advanceToNextPageOrFinish(session, settings) {
  const pagesLimitReached =
    session.pagesProcessed >= settings.maxPages ||
    (settings.endPage && session.currentPageNumber > settings.endPage);

  if (session.pagesProcessed === 0) {
    // First run: ensure originTabId is physically at originSearchUrl, then collect links.
    try {
      const tab = await chrome.tabs.get(session.originTabId);
      // We check if the URL matches. If this is a batch/auto-split run,
      // the first slice URL will be different from the base search URL it was launched on.
      if (tab.url !== session.originSearchUrl) {
        await chrome.tabs.update(session.originTabId, { url: session.originSearchUrl });
        await waitForTabLoad(session.originTabId);
      }
    } catch (err) {
      // Origin tab was closed/crashed — create a replacement
      await logEvent("warn", `Origin tab lost (${err.message}). Creating a replacement tab…`);
      try {
        const newTab = await chrome.tabs.create({ url: session.originSearchUrl, active: false });
        await waitForTabLoad(newTab.id);
        await setSession({ originTabId: newTab.id });
        session.originTabId = newTab.id;
      } catch (retryErr) {
        await logEvent("error", `Failed to recover with a new tab: ${retryErr.message}. Stopping.`);
        await setSession({ status: "stopped" });
        return;
      }
    }

    await collectLinksFromSearchPage(session.originTabId, session.originSearchUrl, session);
    return;
  }

  if (pagesLimitReached) {
    await finishCurrentSearch(session, `page limit reached (${session.pagesProcessed} pages)`);
    return;
  }

  if (!session.nextPageUrl) {
    await finishCurrentSearch(session, "no further pages detected");
    return;
  }

  // Navigate the origin tab to the next search page and collect its links.
  // If the tab was closed/crashed, create a fresh replacement tab and retry
  // instead of stopping dead — this is the most common cause of the
  // "No tab with id" error that used to kill batch runs mid-slice.
  try {
    await chrome.tabs.update(session.originTabId, { url: session.nextPageUrl });
    await waitForTabLoad(session.originTabId);
    await collectLinksFromSearchPage(session.originTabId, session.nextPageUrl, session);
  } catch (err) {
    await logEvent("warn", `Origin tab lost (${err.message}). Creating a replacement tab to continue…`);
    try {
      const newTab = await chrome.tabs.create({ url: session.nextPageUrl, active: false });
      await waitForTabLoad(newTab.id);
      await setSession({ originTabId: newTab.id });
      session.originTabId = newTab.id;
      await collectLinksFromSearchPage(newTab.id, session.nextPageUrl, session);
    } catch (retryErr) {
      await logEvent("error", `Failed to recover with a new tab: ${retryErr.message}. Stopping.`);
      await setSession({ status: "stopped" });
    }
  }
}

async function collectLinksFromSearchPage(tabId, url, session) {
  const parser = getParserForUrl(url);
  const blockerCheck = await safeSendMessage(tabId, { type: "CHECK_BLOCKER" });
  if (blockerCheck?.ok && blockerCheck.blocked) {
    await setSession({ status: "blocked" });
    await logEvent(
      "warn",
      "Bot-check / CAPTCHA detected on the search page. Pausing — solve it manually in the tab, then click Resume."
    );
    return;
  }

  const resp = await safeSendMessage(tabId, {
    type: "COLLECT_LISTING_LINKS",
    supportInfiniteScroll: parser.pageType(url) === "search",
  });

  if (!resp?.ok) {
    await logEvent("error", `Failed to collect links from ${url}: ${resp?.error || "no response"}`);
    await setSession({ status: "stopped" });
    return;
  }

  const currentPage = resp.pagination.currentPage;
  const currentUrlNormalized = new URL(url);
  const nextUrlNormalized = resp.pagination.nextPageUrl ? new URL(resp.pagination.nextPageUrl) : null;
  if (nextUrlNormalized && nextUrlNormalized.toString() === currentUrlNormalized.toString()) {
    await logEvent("warn", `Pagination returned the same URL for page ${currentPage}; ending this slice to avoid duplicate pages.`);
    const updated = await setSession({ pagesProcessed: session.pagesProcessed + 1 });
    await finishCurrentSearch(updated, "pagination repeated the current page");
    return;
  }

  // Zero links on a page is the real "you've run past the last page"
  // signal for a site whose pagination controls we can't reliably read
  // from the DOM (see detectPagination in bayut.js). Stop here instead
  // of requesting page after page of an empty result set forever.
  if (resp.links.length === 0) {
    const updated = await setSession({ pagesProcessed: session.pagesProcessed + 1 });
    await finishCurrentSearch(updated, `page ${currentPage} returned 0 listings`);
    return;
  }

  const entries = resp.links.map((l) => ({
    url: l.url,
    page_number: currentPage,
    site: parser.siteName,
  }));
  const added = await enqueueUrls(entries);
  await logEvent(
    "info",
    `Page ${currentPage}: found ${resp.links.length} listing links (${added} new).`
  );

  await setSession({
    pagesProcessed: session.pagesProcessed + 1,
    currentPageNumber: currentPage,
    nextPageUrl: resp.pagination.nextPageUrl,
    totalPagesHint: resp.pagination.totalPages,
    searchPageInProgress: false,
  });

  runEngineTick();
}

// --- Write Buffering ---
let writeBuffer = [];
let flushTimer = null;

function queueWrite(listing, key) {
  listing.dedupe_key = key;
  writeBuffer.push(listing);
  if (writeBuffer.length >= 25) flushWrites();
  else if (!flushTimer) flushTimer = setTimeout(flushWrites, 2000);
}

async function flushWrites() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!writeBuffer.length) return;
  const batch = writeBuffer;
  writeBuffer = [];
  try {
    await db.listings.bulkPut(batch);
  } catch (e) {
    await logEvent("error", `Failed to flush listing writes: ${e.message}`);
  }
}

let queueUpdateBuffer = [];
let queueFlushTimer = null;

function queueMarkStatus(item, status, extra = {}) {
  const updatedItem = { ...item, status, ...extra };
  const idx = queueUpdateBuffer.findIndex(x => x.id === item.id);
  if (idx !== -1) {
    queueUpdateBuffer[idx] = updatedItem;
  } else {
    queueUpdateBuffer.push(updatedItem);
  }
  if (queueUpdateBuffer.length >= 25) flushQueueUpdates();
  else if (!queueFlushTimer) queueFlushTimer = setTimeout(flushQueueUpdates, 2000);
}

async function flushQueueUpdates() {
  clearTimeout(queueFlushTimer);
  queueFlushTimer = null;
  if (!queueUpdateBuffer.length) return;
  const batch = queueUpdateBuffer;
  queueUpdateBuffer = [];
  try {
    await db.urlQueue.bulkPut(batch);
  } catch (e) {
    await logEvent("error", `Failed to flush queue status updates: ${e.message}`);
  }
}

async function flushAllBuffers() {
  await Promise.all([flushWrites(), flushQueueUpdates()]);
}

// --- Adaptive Concurrency outcome tracker ---
function addJobOutcome(poolType, success) {
  if (poolType === "fetch") {
    fetchOutcomes.push(success);
    if (fetchOutcomes.length > 30) fetchOutcomes.shift();
    jobsSinceLastFetchAdjust++;
    
    if (fetchOutcomes.length >= 30 && jobsSinceLastFetchAdjust >= 20) {
      const failures = fetchOutcomes.filter(x => !x).length;
      const failRate = failures / fetchOutcomes.length;
      if (failRate > 0.15) {
        currentFetchConcurrency = Math.max(2, currentFetchConcurrency - 1);
        logEvent("info", `Adaptive Concurrency: Fetch pool failure rate is ${(failRate * 100).toFixed(1)}%. Decreasing concurrency to ${currentFetchConcurrency}.`);
        jobsSinceLastFetchAdjust = 0;
      } else if (failRate < 0.03 && currentFetchConcurrency < 30) {
        currentFetchConcurrency = currentFetchConcurrency + 1;
        logEvent("info", `Adaptive Concurrency: Fetch pool failure rate is ${(failRate * 100).toFixed(1)}%. Increasing concurrency to ${currentFetchConcurrency}.`);
        jobsSinceLastFetchAdjust = 0;
      }
    }
  } else {
    tabOutcomes.push(success);
    if (tabOutcomes.length > 30) tabOutcomes.shift();
    jobsSinceLastTabAdjust++;
    
    if (tabOutcomes.length >= 30 && jobsSinceLastTabAdjust >= 20) {
      const failures = tabOutcomes.filter(x => !x).length;
      const failRate = failures / tabOutcomes.length;
      if (failRate > 0.15) {
        currentTabConcurrency = Math.max(2, currentTabConcurrency - 1);
        logEvent("info", `Adaptive Concurrency: Tab pool failure rate is ${(failRate * 100).toFixed(1)}%. Decreasing concurrency to ${currentTabConcurrency}.`);
        jobsSinceLastTabAdjust = 0;
      } else if (failRate < 0.03 && currentTabConcurrency < 10) {
        currentTabConcurrency = currentTabConcurrency + 1;
        logEvent("info", `Adaptive Concurrency: Tab pool failure rate is ${(failRate * 100).toFixed(1)}%. Increasing concurrency to ${currentTabConcurrency}.`);
        jobsSinceLastTabAdjust = 0;
      }
    }
  }
}

async function ensureTabPool(settings) {
  const sessionForTabs = await getSession();
  const tabSeedUrl = sessionForTabs.originSearchUrl || "https://www.propertyfinder.ae/";
  const targetConcurrency = currentTabConcurrency !== null ? currentTabConcurrency : (settings.concurrency || 2);
  const alive = [];
  for (const entry of tabPool) {
    try {
      await chrome.tabs.get(entry.tabId);
      alive.push(entry);
    } catch (e) {
      /* tab is gone */
    }
  }
  tabPool = alive;

  while (tabPool.length < targetConcurrency) {
    const tab = await chrome.tabs.create({ url: tabSeedUrl, active: false });
    tabPool.push({ tabId: tab.id, busy: false });
  }
  while (tabPool.length > targetConcurrency) {
    const extra = tabPool.find((e) => !e.busy);
    if (!extra) break;
    tabPool = tabPool.filter((e) => e.tabId !== extra.tabId);
    try {
      await chrome.tabs.remove(extra.tabId);
    } catch (e) {}
  }
}

async function drainQueue(session, settings) {
  if (currentFetchConcurrency === null) currentFetchConcurrency = settings.fetchConcurrency || 20;
  if (currentTabConcurrency === null) currentTabConcurrency = settings.concurrency || 2;

  // 1. Fetch Pool Slot-Filling
  const freeFetchSlots = Math.max(0, currentFetchConcurrency - activeFetchJobs.size);
  if (freeFetchSlots > 0) {
    const fetchPending = await claimPendingFetchUrls(freeFetchSlots);
    for (const item of fetchPending) {
      runFetchJob(item, settings);
    }
  }

  // 2. Tab Pool Slot-Filling
  await ensureTabPool(settings);
  const freeTabSlots = tabPool.filter((e) => !e.busy && !activeTabJobs.has(e.tabId));
  const maxTabFill = Math.max(0, currentTabConcurrency - activeTabJobs.size);
  const tabSlotsToFill = freeTabSlots.slice(0, maxTabFill);
  
  if (tabSlotsToFill.length > 0) {
    const tabPending = await claimPendingTabUrls(tabSlotsToFill.length);
    for (let i = 0; i < tabPending.length; i++) {
      runTabJob(tabSlotsToFill[i], tabPending[i], settings);
    }
  }
}

async function runFetchJob(item, settings) {
  activeFetchJobs.add(item.id);
  try {
    const parser = getParserForUrl(item.url);
    if (!parser) throw new Error("No parser matched");
    const listing = await tryFetchExtract(item.url, parser);
    if (listing) {
      const key = dedupeKey(listing);
      queueWrite(listing, key);
      queueMarkStatus(item, "done");
      const session = await getSession();
      await setSession({ successCount: session.successCount + 1 });
      fetchSuccessCount++;
      await logEvent("info", `Extraction Progress (Fetch): Successes: ${fetchSuccessCount} | Tab Fallbacks: ${tabFallbackCount}`);
      addJobOutcome("fetch", true);
    } else {
      queueMarkStatus(item, "pending", { fetchFailed: true });
      addJobOutcome("fetch", false);
    }
  } catch (err) {
    queueMarkStatus(item, "pending", { fetchFailed: true });
    addJobOutcome("fetch", false);
  } finally {
    activeFetchJobs.delete(item.id);
    runEngineTick();
  }
}

async function runTabJob(poolEntry, item, settings) {
  activeTabJobs.add(item.id);
  poolEntry.busy = true;
  try {
    await chrome.tabs.update(poolEntry.tabId, { url: item.url });
    await waitForTabLoad(poolEntry.tabId);
    if (settings.delayBetweenRequestsMs > 0) {
      await sleep(settings.delayBetweenRequestsMs);
    }
    const blockerCheck = await safeSendMessage(poolEntry.tabId, { type: "CHECK_BLOCKER" });
    if (blockerCheck?.ok && blockerCheck.blocked) {
      await setSession({ status: "blocked" });
      await logEvent("warn", `Bot-check detected on listing ${item.url}. Pausing scrape.`);
      queueMarkStatus(item, "pending");
      addJobOutcome("tab", false);
      return;
    }
    const resp = await safeSendMessage(poolEntry.tabId, {
      type: "EXTRACT_LISTING",
      settings: { enableRawHtml: settings.enableRawHtml },
    });
    if (resp?.ok) {
      const key = dedupeKey(resp.listing);
      queueWrite(resp.listing, key);
      queueMarkStatus(item, "done");
      const session = await getSession();
      await setSession({ successCount: session.successCount + 1 });
      tabFallbackCount++;
      await logEvent("info", `Extraction Progress (Tab Fallback): Successes: ${fetchSuccessCount} | Tab Fallbacks: ${tabFallbackCount}`);
      addJobOutcome("tab", true);
    } else {
      throw new Error(resp?.error || "extraction failed");
    }
  } catch (err) {
    await incrementAttempts(item.id);
    const fresh = await db.urlQueue.get(item.id);
    if (fresh.attempts >= settings.retryAttempts) {
      queueMarkStatus(item, "failed", { lastError: String(err.message || err) });
      const session = await getSession();
      await setSession({ failCount: session.failCount + 1 });
      await logEvent("error", `Gave up on ${item.url} after ${fresh.attempts} attempts: ${err.message}`);
      addJobOutcome("tab", false);
    } else {
      queueMarkStatus(item, "pending");
      const session = await getSession();
      await setSession({ retryCount: session.retryCount + 1 });
      await logEvent("warn", `Retry ${fresh.attempts}/${settings.retryAttempts} for ${item.url}: ${err.message}`);
      addJobOutcome("tab", false);
      await sleep(settings.retryBackoffMs);
    }
  } finally {
    poolEntry.busy = false;
    activeTabJobs.delete(item.id);
    runEngineTick();
  }
}

async function closeAutoSplitTabs() {
  const session = await getSession();
  const scratchTabs = session.autoSplitState?.scratchTabs || [];
  for (const tabId of scratchTabs) {
    if (tabId == null) continue;
    try { await chrome.tabs.remove(tabId); } catch (e) { /* already closed */ }
  }
}
async function closeAllListingTabs() {
  for (const entry of tabPool) {
    try {
      await chrome.tabs.remove(entry.tabId);
    } catch (e) {
      /* ignore */
    }
  }
  tabPool = [];
}

// ---------- Low-level tab helpers ----------

function waitForTabLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function safeSendMessage(tabId, message) {
  const send = () => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response);
    });
  });
  let response = await send();
  if (response?.ok || !/Receiving end does not exist|Could not establish connection/i.test(response?.error || "")) return response;
  // Navigation can complete before the MV3 content script is attached.
  // Inject the already-bundled script once, then retry the message.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/content-script.bundle.js"] });
    await sleep(100);
    response = await send();
  } catch (e) {
    return { ok: false, error: response?.error || String(e?.message || e) };
  }
  return response;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// On service worker startup (browser restart, or worker respawn), if a
// session was left "running" or "blocked", the queue and listings are
// still intact in IndexedDB — we just need to keep draining it. This is
// the "resume after browser restart" requirement.
(async function resumeOnStartup() {
  const session = await getSession();
  if (session.status === "running") {
    ensureAlarm();
    runEngineTick();
  }
})();
