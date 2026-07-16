// storage/db.js
// All persistent scrape data lives here (IndexedDB via Dexie), NOT in
// chrome.storage.local — chrome.storage has a much smaller quota and is
// meant for settings/small state, not thousands of listing records.
//
// Tables:
//   listings   - one row per scraped property (deduped by dedupe_key)
//   urlQueue   - discovered listing URLs waiting to be / being visited
//   pageLog    - one row per search-results page processed
//   eventLog   - append-only log for the live Logs panel
//
// Every write is synchronous-to-disk from IndexedDB's perspective per
// transaction, which is what gives us "never lose collected data" /
// "resume interrupted sessions" — the queue and results are durable after
// every single listing, not just at the end of a page or the whole run.

import Dexie from "../libs/dexie.mjs";

export const db = new Dexie("RealEstateScraperDB");

db.version(1).stores({
  listings: "listing_id, dedupe_key, source_site, page_number, scrape_status, date_collected",
  urlQueue: "++id, url, status, page_number, attempts, site",
  pageLog: "++id, page_number, site, status, timestamp",
  eventLog: "++id, timestamp, level, message",
});

db.version(2).stores({
  listings: "listing_id, dedupe_key, source_site, scrape_status, date_collected",
  urlQueue: "++id, url, status, attempts, site",
  pageLog: "++id, site, status, timestamp",
  eventLog: "++id, timestamp, level, message",
}).upgrade(async (tx) => {
  const removedFields = [
    "sub_community", "latitude", "longitude", "service_charge_aed",
    "payment_cheques", "listing_date", "days_on_market", "trakheesi_permit_status",
    "permit_number", "reference_number", "features", "virtual_tour",
    "images_count", "floor_plan_available", "phone_number", "email",
    "listing_status", "page_number", "listing_position", "og_title"
  ];
  await tx.listings.toCollection().modify((listing) => {
    for (const f of removedFields) {
      delete listing[f];
    }
  });
  await tx.urlQueue.toCollection().modify((item) => {
    delete item.page_number;
  });
  await tx.pageLog.toCollection().modify((log) => {
    delete log.page_number;
  });
});

export async function upsertListing(listing, dedupeKey) {
  const existing = await db.listings.get(listing.listing_id);
  if (existing) {
    await db.listings.update(listing.listing_id, { ...listing, dedupe_key: dedupeKey });
    return "updated";
  }
  await db.listings.add({ ...listing, dedupe_key: dedupeKey });
  return "inserted";
}

export async function getAllListings() {
  return db.listings.toArray();
}

export async function countListings() {
  return db.listings.count();
}

export async function clearAllData() {
  await db.transaction("rw", db.listings, db.urlQueue, db.pageLog, db.eventLog, async () => {
    await db.listings.clear();
    await db.urlQueue.clear();
    await db.pageLog.clear();
    await db.eventLog.clear();
  });
}

export async function enqueueUrls(entries) {
  // entries: [{ url, page_number, site }]
  // Skip URLs already queued or already scraped, so re-running "collect
  // links" on a page you've partially processed doesn't create duplicates.
  const existingUrls = new Set((await db.urlQueue.toArray()).map((e) => e.url));
  const existingListingUrls = new Set(
    (await db.listings.toArray()).map((l) => l.source_url)
  );
  const fresh = entries.filter(
    (e) => !existingUrls.has(e.url) && !existingListingUrls.has(e.url)
  );
  if (fresh.length) {
    await db.urlQueue.bulkAdd(
      fresh.map((e) => ({ ...e, status: "pending", attempts: 0 }))
    );
  }
  return fresh.length;
}

export async function getNextPendingUrls(limit) {
  return db.urlQueue.where("status").equals("pending").limit(limit).toArray();
}

export async function markQueueStatus(id, status, extra = {}) {
  await db.urlQueue.update(id, { status, ...extra });
}

export async function incrementAttempts(id) {
  const row = await db.urlQueue.get(id);
  if (row) await db.urlQueue.update(id, { attempts: (row.attempts || 0) + 1 });
}

export async function logEvent(level, message) {
  await db.eventLog.add({ timestamp: Date.now(), level, message });
  // Keep the log table from growing unbounded across a long run.
  const count = await db.eventLog.count();
  if (count > 5000) {
    const oldest = await db.eventLog.orderBy("timestamp").limit(count - 5000).toArray();
    await db.eventLog.bulkDelete(oldest.map((r) => r.id));
  }
}

export async function getRecentLogs(limit = 200) {
  return db.eventLog.orderBy("timestamp").reverse().limit(limit).toArray();
}

export async function getQueueStats() {
  const all = await db.urlQueue.toArray();
  return {
    pending: all.filter((r) => r.status === "pending").length,
    inProgress: all.filter((r) => r.status === "in_progress").length,
    done: all.filter((r) => r.status === "done").length,
    failed: all.filter((r) => r.status === "failed").length,
    total: all.length,
  };
}

export async function claimPendingFetchUrls(limit) {
  return db.transaction("rw", db.urlQueue, async () => {
    const pending = await db.urlQueue
      .where("status").equals("pending")
      .filter((x) => !x.fetchFailed)
      .limit(limit)
      .toArray();
    if (!pending.length) return [];
    const ids = pending.map((item) => item.id);
    await db.urlQueue.where("id").anyOf(ids).modify({ status: "in_progress" });
    return pending;
  });
}

export async function claimPendingTabUrls(limit) {
  return db.transaction("rw", db.urlQueue, async () => {
    const pending = await db.urlQueue
      .where("status").equals("pending")
      .filter((x) => x.fetchFailed === true)
      .limit(limit)
      .toArray();
    if (!pending.length) return [];
    const ids = pending.map((item) => item.id);
    await db.urlQueue.where("id").anyOf(ids).modify({ status: "in_progress" });
    return pending;
  });
}
