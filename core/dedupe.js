// core/dedupe.js
//
// Cloud-runner deduplication deliberately differs from the browser
// extension: this module is first-seen-wins. Once a listing_id has been
// accepted, subsequent records with the same ID are ignored.

/**
 * Creates a first-seen-wins listing deduper.
 *
 * @param {Iterable<string>} [initialIds] IDs restored from a checkpoint or
 * prior merged output.
 */
export function createFirstSeenDeduper(initialIds = []) {
  const seen = new Set();
  for (const id of initialIds) {
    if (isValidListingId(id)) seen.add(id);
  }

  return {
    /**
     * Accepts a listing only when its listing_id has not been seen before.
     * @param {object} listing
     * @returns {{ accepted: boolean, reason: "accepted" | "duplicate" | "invalid_id" }}
     */
    accept(listing) {
      const id = listing?.listing_id;
      if (!isValidListingId(id)) return { accepted: false, reason: "invalid_id" };
      if (seen.has(id)) return { accepted: false, reason: "duplicate" };
      seen.add(id);
      return { accepted: true, reason: "accepted" };
    },

    has(listingId) {
      return seen.has(listingId);
    },

    /** Returns a copy safe to put in a checkpoint. */
    snapshot() {
      return [...seen];
    },

    get size() {
      return seen.size;
    },
  };
}

/**
 * Deterministically merges record groups in their supplied order.
 * The first occurrence of a valid listing_id is retained.
 *
 * @param {Iterable<Iterable<object>>} groups
 * @param {Iterable<string>} [initialIds]
 */
export function mergeFirstSeen(groups, initialIds = []) {
  const deduper = createFirstSeenDeduper(initialIds);
  const listings = [];
  const stats = { accepted: 0, duplicates: 0, invalidIds: 0 };

  for (const group of groups) {
    for (const listing of group) {
      const result = deduper.accept(listing);
      if (result.accepted) {
        listings.push(listing);
        stats.accepted += 1;
      } else if (result.reason === "duplicate") {
        stats.duplicates += 1;
      } else {
        stats.invalidIds += 1;
      }
    }
  }

  return { listings, completedListingIds: deduper.snapshot(), stats };
}

export function isValidListingId(value) {
  return typeof value === "string" && value.trim().length > 0;
}
