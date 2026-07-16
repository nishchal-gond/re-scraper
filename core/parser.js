// core/parser.js
//
// PropertyFinder-only parser for Playwright. extractPageData is intentionally
// self-contained: Playwright serializes it into page.evaluate(), where module
// imports and Node globals are unavailable.

export const EXPORT_FIELDS = Object.freeze([
  "listing_id", "source_url", "source_site", "date_collected",
  "purpose", "community", "property_type", "bedrooms", "bathrooms", "size_sqft", "price_aed",
  "off_plan", "developer", "BUA", "plot_size_sqft", "annual_rent_aed", "furnished", "agency", "agent_name",
  "title", "description", "amenities", "parking", "floor", "last_updated",
  "scrape_status", "scrape_time_ms", "canonical_url", "og_image", "json_ld_present",
]);

export const ANOMALY_FIELDS = Object.freeze([
  "price_anomaly_hard",
  "price_anomaly_relative",
]);

export const OUTPUT_FIELDS = Object.freeze([...EXPORT_FIELDS, ...ANOMALY_FIELDS]);

export function isPropertyFinderUrl(url) {
  return /(^https?:\/\/)?(www\.)?propertyfinder\.ae\//.test(url || "");
}

export function pageType(url) {
  if (/-\d{5,}\.html/.test(url || "")) return "listing";
  if (/\/search(?:[/?]|$)/.test(url || "") || /\/(buy|rent)\//.test(url || "")) return "search";
  return "unknown";
}

export function buildPriceFilteredUrl(baseUrl, minPrice, maxPrice) {
  const url = new URL(baseUrl);
  if (minPrice != null) url.searchParams.set("pf", String(Math.round(minPrice)));
  else url.searchParams.delete("pf");
  if (maxPrice != null) url.searchParams.set("pt", String(Math.round(maxPrice)));
  else url.searchParams.delete("pt");
  url.searchParams.delete("page");
  return url.toString();
}

export function buildSortedPriceDescendingUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("ob", "pd");
  return url.toString();
}

/**
 * Runs inside page.evaluate().
 * @param {{ mode: "listing" | "search" | "count" | "bounds" | "blocker", sourceUrl?: string, hardPricePerSqft?: number }} input
 */
export function extractPageData(input) {
  const origin = "https://www.propertyfinder.ae";
  const sourceUrl = input.sourceUrl || location.href;
  const hardPricePerSqft = Number(input.hardPricePerSqft) || 100000;

  const whitespace = (value) => {
    if (value == null) return null;
    const clean = String(value).replace(/\s+/g, " ").trim();
    return clean || null;
  };
  const number = (value) => {
    if (value == null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const clean = String(value).replace(/[^0-9.\-]/g, "");
    if (!clean || clean === "-" || clean === ".") return null;
    const result = Number.parseFloat(clean);
    return Number.isFinite(result) ? result : null;
  };
  // Existing extension behavior: a range such as "115M–165M" returns the
  // first (low-end) amount because the first M/K match wins.
  const price = (value) => {
    if (value == null) return null;
    const text = String(value).toUpperCase().replace(/AED|YEAR|YR|\/|PER|MONTH/g, " ");
    const million = text.match(/([\d.]+)\s*M\b/);
    if (million) return Math.round(Number.parseFloat(million[1]) * 1_000_000);
    const thousand = text.match(/([\d.]+)\s*K\b/);
    if (thousand) return Math.round(Number.parseFloat(thousand[1]) * 1_000);
    return number(text);
  };
  const bedrooms = (value) => {
    if (value == null) return null;
    const text = String(value).trim().toUpperCase();
    if (text === "STUDIO" || text === "S") return 0;
    const result = number(text);
    return result == null ? null : Math.round(result);
  };
  const boolean = (value) => {
    if (value == null) return null;
    if (typeof value === "boolean") return value;
    const text = String(value).trim().toLowerCase();
    if (["yes", "true", "furnished", "available", "1"].includes(text)) return true;
    if (["no", "false", "unfurnished", "unavailable", "0"].includes(text)) return false;
    return null;
  };
  const label = (value) => {
    if (value == null) return null;
    if (typeof value === "object") {
      const candidate = value.name ?? value.title ?? value.label ?? value.text ?? value.value ?? null;
      return candidate != null && typeof candidate !== "object" ? whitespace(candidate) : null;
    }
    return whitespace(value);
  };
  const array = (value) => Array.isArray(value)
    ? (value.map(label).filter(Boolean).join("; ") || null)
    : whitespace(value);
  const jsonBlocks = () => [...document.querySelectorAll('script[type="application/ld+json"]')]
    .flatMap((node) => { try { return [JSON.parse(node.textContent || "")]; } catch { return []; } });
  const flattenJsonLd = (value, typeName, result = []) => {
    if (Array.isArray(value)) value.forEach((item) => flattenJsonLd(item, typeName, result));
    else if (value && typeof value === "object") {
      const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
      if (types.includes(typeName)) result.push(value);
      if (value["@graph"]) flattenJsonLd(value["@graph"], typeName, result);
    }
    return result;
  };
  const jsonLdByType = (typeName) => jsonBlocks().flatMap((block) => flattenJsonLd(block, typeName));
  const nextData = () => {
    const node = document.getElementById("__NEXT_DATA__");
    try { return node ? JSON.parse(node.textContent || "") : null; } catch { return null; }
  };
  const deepFind = (root, names, maxDepth = 8, depth = 0, seen = new WeakSet()) => {
    if (root == null || typeof root !== "object" || depth > maxDepth || seen.has(root)) return undefined;
    seen.add(root);
    const lowered = names.map((name) => name.toLowerCase());
    for (const key of Object.keys(root)) {
      if (lowered.includes(key.toLowerCase())) {
        const value = root[key];
        if (value !== null && value !== undefined && value !== "") return value;
      }
    }
    for (const key of Object.keys(root)) {
      const found = root[key] && typeof root[key] === "object" ? deepFind(root[key], names, maxDepth, depth + 1, seen) : undefined;
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const meta = (name) => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute("content") || null;
  const canonical = () => document.querySelector('link[rel="canonical"]')?.getAttribute("href") || null;
  const blocked = () => /checking your browser|captcha|access denied|unusual traffic/i.test((document.body?.innerText || "").slice(0, 2000));
  const scanLabel = (patterns) => {
    for (const element of document.querySelectorAll("body *")) {
      const ownText = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim()).join(" ").trim();
      if (!ownText || ownText.length > 40 || !patterns.some((pattern) => pattern.test(ownText))) continue;
      const sibling = element.nextElementSibling;
      if (sibling) {
        const text = sibling.textContent.trim();
        if (text && text.length < 80) return text;
      }
      for (const siblingElement of element.parentElement?.children || []) {
        if (siblingElement === element) continue;
        const text = siblingElement.textContent.trim();
        if (text && text.length < 80) return text;
      }
    }
    return null;
  };
  const slugSpecs = (url) => {
    try {
      const slug = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
      const match = slug.match(/^([a-z-]+?)-for-(sale|rent)-/i);
      return match ? {
        property_type: whitespace(match[1].replace(/-/g, " ")),
        purpose: match[2][0].toUpperCase() + match[2].slice(1).toLowerCase(),
      } : {};
    } catch { return {}; }
  };
  const descriptionSpecs = (description) => {
    const match = String(description || "").match(/^([\d,]+)\s*sqft\s+([a-z\s]+?)\s+for\s+(sale|rent)\b/i);
    return match ? {
      size_sqft: number(match[1]),
      property_type: whitespace(match[2]),
      purpose: match[3][0].toUpperCase() + match[3].slice(1).toLowerCase(),
    } : {};
  };
  const findListingPrice = (value, depth = 0, seen = new WeakSet()) => {
    if (value == null || typeof value !== "object" || depth > 10 || seen.has(value)) return null;
    seen.add(value);
    for (const key of ["priceAed", "priceAED", "sellingPrice", "salePrice", "totalPrice", "amount", "value"]) {
      const found = price(value[key]);
      if (Number.isFinite(found) && found > 0) return found;
    }
    if (value.price && typeof value.price === "object") {
      const found = price(value.price.value ?? value.price.amount ?? value.price.total ?? value.price.lowPrice);
      if (Number.isFinite(found) && found > 0) return found;
    }
    for (const key of Object.keys(value)) {
      const found = findListingPrice(value[key], depth + 1, seen);
      if (found != null) return found;
    }
    return null;
  };
  const setPurposePrice = (listing, raw) => {
    const normalized = price(raw);
    if (!Number.isFinite(normalized) || normalized <= 0) return;
    if (/rent/i.test(listing.purpose || "")) listing.annual_rent_aed = normalized;
    else listing.price_aed = normalized;
  };
  const makeListingId = (url, reference) => {
    if (reference) return `ref_${reference}`;
    let hash = 0;
    for (let index = 0; index < url.length; index += 1) { hash = ((hash << 5) - hash) + url.charCodeAt(index); hash |= 0; }
    return `url_${Math.abs(hash)}`;
  };
  const normalizeUrl = (value) => {
    try { const url = new URL(value, origin); return url.origin + url.pathname; } catch { return null; }
  };
  const collectSearchListings = () => {
    const listings = [];
    const seen = new Set();
    const data = nextData();
    const walk = (value) => {
      if (!value || typeof value !== "object") return;
      const rawUrl = value.uri || value.path || value.shareUrl;
      const rawPrice = value.price?.value || value.price?.amount || value.price || value.priceVal;
      const resolvedUrl = typeof rawUrl === "string" ? normalizeUrl(rawUrl) : null;
      const resolvedPrice = number(rawPrice);
      if (resolvedUrl && Number.isFinite(resolvedPrice) && resolvedPrice > 0 && !seen.has(resolvedUrl)) {
        seen.add(resolvedUrl); listings.push({ url: resolvedUrl, price: resolvedPrice });
      }
      Object.values(value).forEach(walk);
    };
    if (data) walk(data);
    if (listings.length) return listings;
    for (const card of document.querySelectorAll('a[data-testid*="property-card" i], a[class*="card-link" i], [class*="card-container" i], [data-testid="property-card"]')) {
      const href = normalizeUrl(card.getAttribute("href") || card.querySelector("a")?.getAttribute("href"));
      if (!href || seen.has(href)) continue;
      const text = card.textContent || "";
      const match = text.replace(/,/g, "").match(/(?:AED|USD)\s*(\d+)/i) || text.replace(/,/g, "").match(/(\d+)\s*(?:AED|USD)/i) || text.replace(/,/g, "").match(/\b\d{5,12}\b/);
      const foundPrice = match ? number(match[1] || match[0]) : null;
      if (Number.isFinite(foundPrice) && foundPrice > 0) { seen.add(href); listings.push({ url: href, price: foundPrice }); }
    }
    return listings;
  };
  const resultCount = () => {
    const hasCards = document.querySelector('a[data-testid*="property-card" i], a[class*="card-link" i], a[href*="/plp/"], a[href*=".html"]');
    if (!hasCards) {
      const body = document.body?.innerText || "";
      return /no\s*(?:properties|results|listed|matching|listings)\b/i.test(body) ? 0 : null;
    }
    const data = nextData();
    const props = data?.props?.pageProps || data?.props || data;
    const fromData = deepFind(props, ["totalResults", "resultCount", "total", "hits", "totalCount"]);
    const parsed = number(fromData);
    if (Number.isFinite(parsed)) return parsed;
    for (const element of document.querySelectorAll("h1, h2, h3, h4, span, div")) {
      const text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(" ").trim();
      if (!text || text.length > 100) continue;
      if (/no\s*(?:properties|results|listed|matching|listings)\b|couldn't\s*find|don't\s*have\s*any/i.test(text)) return 0;
      const match = text.match(/(?:^|\s)([\d,]+)\s*(properties|results|listed)\b/i);
      if (match) return number(match[1]);
    }
    return null;
  };
  const collectLinks = () => {
    const links = [];
    const seen = new Set();
    if (/no\s*(?:properties|results|matching|listings)\b/i.test(document.body?.innerText || "")) return links;
    for (const anchor of document.querySelectorAll('a[data-testid*="property-card" i], a[class*="card-link" i], a[href*="/plp/"], a[href*=".html"]')) {
      const href = normalizeUrl(anchor.getAttribute("href"));
      if (!href || !href.startsWith(origin) || (!/\/plp\//i.test(href) && !/-\d{5,}\.html$/i.test(href)) || seen.has(href)) continue;
      seen.add(href); links.push({ url: href, position: links.length + 1 });
    }
    return links;
  };
  const pagination = () => {
    const url = new URL(sourceUrl);
    const currentPage = Number.parseInt(url.searchParams.get("page") || "1", 10) || 1;
    const next = document.querySelector('a[rel="next"], a[aria-label*="next" i], a[data-testid*="next" i]');
    let nextPageUrl = null;
    if (next?.getAttribute("href") && next.getAttribute("aria-disabled") !== "true" && !next.hasAttribute("disabled")) {
      try { nextPageUrl = new URL(next.getAttribute("href"), sourceUrl).toString(); } catch { /* no-op */ }
    } else {
      const total = resultCount(); const pageSize = collectLinks().length;
      if (Number.isFinite(total) && pageSize > 0 && total > currentPage * pageSize) {
        url.searchParams.set("page", String(currentPage + 1)); nextPageUrl = url.toString();
      }
    }
    return { currentPage, totalPages: null, nextPageUrl, mode: "numbered" };
  };

  if (input.mode === "blocker") return { blocked: blocked() };
  if (input.mode === "count") return { blocked: blocked(), count: blocked() ? null : resultCount() };
  if (input.mode === "bounds") {
    const prices = collectSearchListings().map((item) => item.price).filter((value) => Number.isFinite(value) && value > 0);
    return { blocked: blocked(), bounds: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null };
  }
  if (input.mode === "search") return { blocked: blocked(), links: collectLinks(), pagination: pagination(), listings: collectSearchListings() };
  if (blocked()) return { blocked: true, listing: null };

  const listing = {};
  listing.source_url = sourceUrl;
  listing.source_site = "propertyfinder";
  listing.canonical_url = canonical() || sourceUrl;
  listing.og_image = meta("og:image");
  const ldBlocks = ["Product", "RealEstateListing", "Residence"].flatMap(jsonLdByType);
  listing.json_ld_present = ldBlocks.length > 0;
  const ld = ldBlocks[0] || {};
  listing.title = whitespace(ld.name) || meta("og:title") || null;
  listing.description = null;
  Object.assign(listing, slugSpecs(sourceUrl));
  const data = nextData();
  const props = data?.props?.pageProps || data?.props || data;
  const reference = whitespace(deepFind(props, ["referenceNumber", "reference"]));
  listing.bedrooms = bedrooms(deepFind(props, ["bedrooms", "rooms"]));
  listing.bathrooms = number(deepFind(props, ["bathrooms", "baths"]));
  const rawSize = deepFind(props, ["sizeSqft", "squareFeet", "areaSqft", "floorSize", "size", "area"]);
  listing.size_sqft = number(rawSize?.value ?? rawSize?.amount ?? rawSize);
  if (listing.property_type == null) listing.property_type = whitespace(deepFind(props, ["propertyType", "propertyTypeName", "category"]));
  listing.agency = label(deepFind(props, ["agencyName", "brokerName", "agency"]));
  listing.agent_name = label(deepFind(props, ["agentName", "contactName"]));
  listing.developer = label(deepFind(props, ["developerName", "developer", "projectDeveloper"]));
  listing.community = label(deepFind(props, ["community", "locationName"]));
  listing.amenities = array(deepFind(props, ["amenities", "features"]));
  listing.off_plan = boolean(deepFind(props, ["offPlan", "isOffPlan"]));
  listing.furnished = boolean(deepFind(props, ["furnished", "isFurnished"]));
  listing.parking = label(deepFind(props, ["parking", "parkingSpaces", "numberOfParkingSpaces"]));
  listing.floor = label(deepFind(props, ["floor", "floorNumber"]));
  const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
  setPurposePrice(listing, findListingPrice(props) ?? offer?.price ?? offer?.lowPrice);
  if (listing.size_sqft == null) listing.size_sqft = number(ld.floorSize?.value ?? ld.floorSize?.amount ?? ld.floorSize) ?? descriptionSpecs(ld.description).size_sqft;
  if (listing.size_sqft == null) listing.size_sqft = number(scanLabel([/^(?:built[- ]?up )?area$/i, /^size$/i, /sq\s*ft|sqft/i]));
  listing.BUA = number(scanLabel([/^BUA$/i, /built[\s-]?up\s*area/i]));
  listing.plot_size_sqft = number(scanLabel([/^plot\s*size$/i, /^plot\s*area$/i]));
  if (listing.agency == null) listing.agency = whitespace(scanLabel([/^agency$/i, /^broker$/i]));
  if (listing.agent_name == null) listing.agent_name = whitespace(scanLabel([/^agent$/i, /^listed\s*by$/i, /^contact\s*agent$/i]));
  if (listing.developer == null) listing.developer = whitespace(scanLabel([/^developer$/i, /^developed\s*by$/i]));
  if (listing.price_aed == null && listing.annual_rent_aed == null) setPurposePrice(listing, document.querySelector('[aria-label*="Price" i], [class*="price" i]')?.textContent);
  listing.listing_id = makeListingId(sourceUrl, reference);
  listing.date_collected = new Date().toISOString();
  listing.last_updated = listing.date_collected;
  const effectivePrice = listing.price_aed ?? listing.annual_rent_aed;
  const ppsf = Number.isFinite(effectivePrice) && Number.isFinite(listing.size_sqft) && listing.size_sqft > 0 ? effectivePrice / listing.size_sqft : null;
  listing.price_anomaly_hard = ppsf == null ? null : ppsf > hardPricePerSqft;
  listing.price_anomaly_relative = null;
  return { blocked: false, listing };
}
