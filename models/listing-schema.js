// models/listing-schema.js
// Canonical field list for one scraped listing row.
// Every parser must return an object with (a subset of) these keys.
// Unknown/unavailable fields MUST be null, never guessed or empty-string-faked.

export const LISTING_FIELDS = [
  "listing_id", "source_url", "source_site", "date_collected",
  "purpose", "community", "property_type", "bedrooms", "bathrooms", "size_sqft", "price_aed",
  "off_plan", "developer", "BUA", "plot_size_sqft", "annual_rent_aed", "furnished", "agency", "agent_name",
  "title", "description", "amenities", "parking", "floor", "last_updated",
  "scrape_status", "scrape_time_ms", "canonical_url", "og_image", "json_ld_present"
];

export function blankListing() {
  const obj = {};
  for (const f of LISTING_FIELDS) obj[f] = null;
  return obj;
}

export function makeListingId(sourceUrl, referenceNumber) {
  // Prefer the site's own reference number (stable across scrapes / dedup-friendly).
  if (referenceNumber) return `ref_${referenceNumber}`;
  // Fallback: deterministic hash of the URL so re-scraping the same listing
  // produces the same id (needed for dedup + resume).
  let hash = 0;
  for (let i = 0; i < sourceUrl.length; i++) {
    hash = (hash << 5) - hash + sourceUrl.charCodeAt(i);
    hash |= 0;
  }
  return `url_${Math.abs(hash)}`;
}
