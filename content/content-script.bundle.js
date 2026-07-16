(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // parser/propertyfinder.js
  var propertyfinder_exports = {};
  __export(propertyfinder_exports, {
    buildPriceFilteredUrl: () => buildPriceFilteredUrl,
    buildSortedPriceDescendingUrl: () => buildSortedPriceDescendingUrl,
    collectListingLinks: () => collectListingLinks,
    detectBlocker: () => detectBlocker,
    detectPagination: () => detectPagination,
    extractListing: () => extractListing,
    extractSearchPageListings: () => extractSearchPageListings,
    getPriceBounds: () => getPriceBounds,
    getResultsCount: () => getResultsCount,
    matches: () => matches,
    pageType: () => pageType,
    siteName: () => siteName
  });

  // parser/shared-extractors.js
  function getNextData(source) {
    if (typeof source === "string") {
      const match = source.match(/<script\s+[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (!match) return null;
      try {
        return JSON.parse(match[1]);
      } catch (e) {
        return null;
      }
    } else if (source && typeof source.getElementById === "function") {
      const el = source.getElementById("__NEXT_DATA__");
      if (!el) return null;
      try {
        return JSON.parse(el.textContent);
      } catch (e) {
        return null;
      }
    }
    return null;
  }
  function getJsonLdBlocks(source) {
    const blocks = [];
    if (typeof source === "string") {
      const regex = /<script\s+[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
      let match;
      while ((match = regex.exec(source)) !== null) {
        try {
          blocks.push(JSON.parse(match[1]));
        } catch (e) {
        }
      }
    } else if (source && typeof source.querySelectorAll === "function") {
      const nodes = source.querySelectorAll('script[type="application/ld+json"]');
      nodes.forEach((n) => {
        try {
          blocks.push(JSON.parse(n.textContent));
        } catch (e) {
        }
      });
    }
    return blocks;
  }
  function findJsonLdByType(source, typeName) {
    const blocks = getJsonLdBlocks(source);
    const flat = [];
    for (const b of blocks) {
      if (Array.isArray(b)) flat.push(...b);
      else if (b["@graph"]) flat.push(...b["@graph"]);
      else flat.push(b);
    }
    return flat.filter((b) => {
      const t = b["@type"];
      if (!t) return false;
      return Array.isArray(t) ? t.includes(typeName) : t === typeName;
    });
  }

  // utils/structured-data.js
  function findJsonLdByType2(typeName) {
    return findJsonLdByType(document, typeName);
  }
  function getNextData2() {
    return getNextData(document);
  }
  function getMetaContent(name) {
    const el = document.querySelector(`meta[name="${name}"]`) || document.querySelector(`meta[property="${name}"]`);
    return el ? el.getAttribute("content") : null;
  }
  function getOpenGraph() {
    return {
      title: getMetaContent("og:title"),
      description: getMetaContent("og:description"),
      image: getMetaContent("og:image"),
      url: getMetaContent("og:url")
    };
  }
  function getCanonicalUrl() {
    const el = document.querySelector('link[rel="canonical"]');
    return el ? el.getAttribute("href") : null;
  }
  function deepFind(obj, keyNames, maxDepth = 8, _depth = 0, _seen = /* @__PURE__ */ new WeakSet()) {
    if (obj === null || typeof obj !== "object" || _depth > maxDepth) return void 0;
    if (_seen.has(obj)) return void 0;
    _seen.add(obj);
    const lowerNames = keyNames.map((k) => k.toLowerCase());
    for (const key of Object.keys(obj)) {
      if (lowerNames.includes(key.toLowerCase())) {
        const val = obj[key];
        if (val !== null && val !== void 0 && val !== "") return val;
      }
    }
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === "object") {
        const found = deepFind(val, keyNames, maxDepth, _depth + 1, _seen);
        if (found !== void 0) return found;
      }
    }
    return void 0;
  }
  function scanLabeledValue(document2, labelPatterns) {
    const candidates = document2.querySelectorAll("body *");
    for (const el of candidates) {
      const ownText = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join(" ").trim();
      if (!ownText || ownText.length > 40) continue;
      if (!labelPatterns.some((re) => re.test(ownText))) continue;
      const sib = el.nextElementSibling;
      if (sib) {
        const t = sib.textContent.trim();
        if (t && t.length < 80) return t;
      }
      const parent = el.parentElement;
      if (parent) {
        for (const s of parent.children) {
          if (s === el) continue;
          const t = s.textContent.trim();
          if (t && t.length > 0 && t.length < 80) return t;
        }
      }
    }
    return null;
  }

  // utils/normalize.js
  function normalizeWhitespace(str) {
    if (str === null || str === void 0) return null;
    const cleaned = String(str).replace(/\s+/g, " ").trim();
    return cleaned.length ? cleaned : null;
  }
  function normalizeNumber(value) {
    if (value === null || value === void 0) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const cleaned = String(value).replace(/[^0-9.\-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return null;
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  function normalizePrice(value) {
    if (value === null || value === void 0) return null;
    let str = String(value).toUpperCase().replace(/AED|YEAR|YR|\/|PER|MONTH/g, " ");
    const millionMatch = str.match(/([\d.]+)\s*M\b/);
    if (millionMatch) return Math.round(parseFloat(millionMatch[1]) * 1e6);
    const kMatch = str.match(/([\d.]+)\s*K\b/);
    if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1e3);
    return normalizeNumber(str);
  }
  function normalizeBedrooms(value) {
    if (value === null || value === void 0) return null;
    const str = String(value).trim().toUpperCase();
    if (str === "STUDIO" || str === "S") return 0;
    const n = normalizeNumber(str);
    return n === null ? null : Math.round(n);
  }
  function normalizeBoolean(value) {
    if (value === null || value === void 0) return null;
    if (typeof value === "boolean") return value;
    const str = String(value).trim().toLowerCase();
    if (["yes", "true", "furnished", "available", "1"].includes(str)) return true;
    if (["no", "false", "unfurnished", "unavailable", "0"].includes(str)) return false;
    return null;
  }
  function normalizeLabel(v) {
    if (v === null || v === void 0) return null;
    if (typeof v === "object") {
      const label = v.name ?? v.title ?? v.label ?? v.text ?? v.value ?? null;
      if (label != null && typeof label !== "object") return normalizeWhitespace(label);
      return null;
    }
    return normalizeWhitespace(v);
  }
  function normalizeArray(value) {
    if (value === null || value === void 0) return null;
    if (Array.isArray(value)) {
      const cleaned = value.map(normalizeLabel).filter(Boolean);
      return cleaned.length ? cleaned.join("; ") : null;
    }
    return normalizeWhitespace(value);
  }

  // models/listing-schema.js
  function makeListingId(sourceUrl, referenceNumber) {
    if (referenceNumber) return `ref_${referenceNumber}`;
    let hash = 0;
    for (let i = 0; i < sourceUrl.length; i++) {
      hash = (hash << 5) - hash + sourceUrl.charCodeAt(i);
      hash |= 0;
    }
    return `url_${Math.abs(hash)}`;
  }

  // parser/propertyfinder.js
  var siteName = "propertyfinder";
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
      purpose: purposeRaw[0].toUpperCase() + purposeRaw.slice(1).toLowerCase()
    };
  }
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
    }
    return out;
  }
  function findListingPrice(value, depth = 0, seen = /* @__PURE__ */ new WeakSet()) {
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
  function getResultsCount(document2) {
    const hasCards = document2.querySelector(
      'a[data-testid*="property-card" i], a[class*="card-link" i], a[href*="/plp/"], a[href*=".html"]'
    );
    if (!hasCards) {
      if (detectBlocker(document2)) return null;
      const bodyText = document2.body?.innerText || "";
      if (/no\\s*(?:properties|results|listed|matching|listings)\\b/i.test(bodyText)) return 0;
      return null;
    }
    const nextData = getNextData2();
    if (nextData) {
      const props = nextData.props?.pageProps || nextData.props || nextData;
      const fromData = deepFind(props, ["totalResults", "resultCount", "total", "hits", "totalCount"]);
      const n = normalizeNumber(fromData);
      if (Number.isFinite(n)) return n;
    }
    const elements = document2.querySelectorAll("h1, h2, h3, h4, span, div");
    for (const el of elements) {
      let text = "";
      for (const child of el.childNodes) {
        if (child.nodeType === 3) text += child.textContent + " ";
      }
      text = text.trim();
      if (!text || text.length > 100) continue;
      if (/no\s*(?:properties|results|listed|matching|listings)\b/i.test(text) || /couldn't\s*find|don't\s*have\s*any/i.test(text)) {
        return 0;
      }
      const m = text.match(/(?:^|\s)([\d,]+)\s*(properties|results|listed)\b/i);
      if (m) {
        const num = normalizeNumber(m[1]);
        if (Number.isFinite(num)) return num;
      }
    }
    const h1 = document2.querySelector("h1");
    if (h1) {
      const text = h1.textContent;
      if (/no\s*(?:properties|results|listed|matching)\b/i.test(text)) return 0;
      const m = text.match(/([\d,]+)\s*(properties|results|listed)/i);
      if (m) return normalizeNumber(m[1]);
    }
    return null;
  }
  function buildPriceFilteredUrl(baseUrl, minPrice, maxPrice) {
    const u = new URL(baseUrl);
    if (minPrice != null) u.searchParams.set("pf", String(Math.round(minPrice)));
    else u.searchParams.delete("pf");
    if (maxPrice != null) u.searchParams.set("pt", String(Math.round(maxPrice)));
    else u.searchParams.delete("pt");
    u.searchParams.delete("page");
    return u.toString();
  }
  function matches(url) {
    return /(^https?:\/\/)?(www\.)?propertyfinder\.ae\//.test(url);
  }
  function pageType(url) {
    if (/-\d{5,}\.html/.test(url)) return "listing";
    if (/\/search(?:[/?]|$)/.test(url) || /\/(buy|rent)\//.test(url)) return "search";
    return "unknown";
  }
  function detectBlocker(document2) {
    const bodyText = document2.body ? document2.body.innerText.slice(0, 2e3) : "";
    return /checking your browser|captcha|access denied|unusual traffic/i.test(bodyText);
  }
  function collectListingLinks(document2) {
    const pageText = document2.body?.innerText || "";
    if (/no\s*properties\s*found|no\s*(?:properties|results|matching|listings)\b/i.test(pageText)) return [];
    const seen = /* @__PURE__ */ new Set();
    const results = [];
    const anchors = document2.querySelectorAll(
      'a[data-testid*="property-card" i], a[class*="card-link" i], a[href*="/plp/"], a[href*=".html"]'
    );
    let position = 0;
    anchors.forEach((a) => {
      let href = a.getAttribute("href");
      if (!href) return;
      if (href.startsWith("/")) href = "https://www.propertyfinder.ae" + href;
      try {
        const u = new URL(href);
        if (u.hostname !== "www.propertyfinder.ae" || !/\/plp\//i.test(u.pathname) && !/-\d{5,}\.html$/i.test(u.pathname)) return;
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
  function detectPagination(document2, currentUrl) {
    let currentPage = 1;
    try {
      const u = new URL(currentUrl);
      const p = parseInt(u.searchParams.get("page"), 10);
      if (Number.isFinite(p) && p > 0) currentPage = p;
    } catch (e) {
    }
    let nextPageUrl = null;
    const nextControl = document2.querySelector(
      'a[rel="next"], a[aria-label*="next" i], a[data-testid*="next" i]'
    );
    const href = nextControl?.getAttribute("href");
    const disabled = nextControl?.getAttribute("aria-disabled") === "true" || nextControl?.hasAttribute("disabled");
    if (href && !disabled) {
      try {
        nextPageUrl = new URL(href, currentUrl).toString();
      } catch (e) {
      }
    } else {
      const total = getResultsCount(document2);
      const pageSize = collectListingLinks(document2).length;
      if (Number.isFinite(total) && pageSize > 0 && total > currentPage * pageSize) {
        try {
          const u = new URL(currentUrl);
          u.searchParams.set("page", String(currentPage + 1));
          nextPageUrl = u.toString();
        } catch (e) {
        }
      }
    }
    return { currentPage, totalPages: null, nextPageUrl, mode: "numbered" };
  }
  function extractListing(document2, sourceUrl) {
    const listing = {};
    listing.source_url = sourceUrl;
    listing.source_site = siteName;
    listing.canonical_url = getCanonicalUrl() || sourceUrl;
    const og = getOpenGraph();
    listing.og_image = og.image;
    const jsonLdBlocks = [
      ...findJsonLdByType2("Product"),
      ...findJsonLdByType2("RealEstateListing"),
      ...findJsonLdByType2("Residence")
    ];
    listing.json_ld_present = jsonLdBlocks.length > 0;
    const ld = jsonLdBlocks[0] || {};
    listing.title = normalizeWhitespace(ld.name) || og.title || null;
    listing.description = null;
    const fromUrl = parseUrlSlug(sourceUrl);
    if (fromUrl.property_type) listing.property_type = fromUrl.property_type;
    if (fromUrl.purpose) listing.purpose = fromUrl.purpose;
    const nextData = getNextData2();
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
    if (listing.size_sqft == null) {
      const ldSize = ld.floorSize?.value ?? ld.floorSize?.amount ?? ld.floorSize;
      listing.size_sqft = normalizeNumber(ldSize);
    }
    if (listing.size_sqft == null && ld.description) {
      listing.size_sqft = parseDescriptionSpecs(ld.description).size_sqft ?? null;
    }
    if (listing.size_sqft == null) {
      const v = scanLabeledValue(document2, [/^(?:built[- ]?up )?area$/i, /^size$/i, /sq\s*ft|sqft/i]);
      if (v) listing.size_sqft = normalizeNumber(v);
    }
    if (listing.BUA == null) {
      const v = scanLabeledValue(document2, [/^BUA$/i, /built[\s-]?up\s*area/i]);
      if (v) listing.BUA = normalizeNumber(v);
    }
    if (listing.plot_size_sqft == null) {
      const v = scanLabeledValue(document2, [/^plot\s*size$/i, /^plot\s*area$/i]);
      if (v) listing.plot_size_sqft = normalizeNumber(v);
    }
    if (listing.agency == null) {
      const v = scanLabeledValue(document2, [/^agency$/i, /^broker$/i]);
      if (v) listing.agency = normalizeWhitespace(v);
    }
    if (listing.agent_name == null) {
      const v = scanLabeledValue(document2, [/^agent$/i, /^listed\s*by$/i, /^contact\s*agent$/i]);
      if (v) listing.agent_name = normalizeWhitespace(v);
    }
    if (listing.developer == null) {
      const v = scanLabeledValue(document2, [/^developer$/i, /^developed\s*by$/i]);
      if (v) listing.developer = normalizeWhitespace(v);
    }
    if (listing.price_aed == null && listing.annual_rent_aed == null) {
      const priceEl = document2.querySelector('[aria-label*="Price" i], [class*="price" i]');
      if (priceEl) {
        setPurposePrice(listing, priceEl.textContent);
      }
    }
    listing.listing_id = makeListingId(sourceUrl, refNum);
    listing.date_collected = (/* @__PURE__ */ new Date()).toISOString();
    listing.last_updated = listing.date_collected;
    return listing;
  }
  function getPriceBounds(document2) {
    const prices = extractSearchPageListings(document2).map((item) => item.price).filter((price) => Number.isFinite(price) && price > 0);
    if (!prices.length) return null;
    return { min: Math.min(...prices), max: Math.max(...prices) };
  }
  function buildSortedPriceDescendingUrl(baseUrl) {
    const u = new URL(baseUrl);
    u.searchParams.set("ob", "pd");
    return u.toString();
  }
  function extractSearchPageListings(document2) {
    const listings = [];
    const seenUrls = /* @__PURE__ */ new Set();
    const nextData = getNextData2();
    if (nextData) {
      let recurse = function(obj) {
        if (!obj || typeof obj !== "object") return;
        const hasPrice = obj.price !== void 0 || obj.priceVal !== void 0;
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
            } catch (e) {
            }
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
      };
      recurse(nextData);
    }
    if (listings.length === 0) {
      const cards = document2.querySelectorAll(
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

  // parser/registry.js
  var PARSERS = [propertyfinder_exports];
  function getParserForUrl(url) {
    return PARSERS.find((p) => p.matches(url)) || null;
  }

  // content/content-script.js
  var parser = getParserForUrl(location.href);
  function waitForDomQuiet(quietMs = 600, timeoutMs = 8e3) {
    return new Promise((resolve) => {
      let timer = setTimeout(finish, quietMs);
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, quietMs);
      });
      const hardTimeout = setTimeout(finish, timeoutMs);
      function finish() {
        observer.disconnect();
        clearTimeout(hardTimeout);
        resolve();
      }
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
  }
  function waitForSpinnerGone(timeoutMs = 8e3) {
    const spinnerSelectors = [
      '[class*="spinner" i]',
      '[class*="loading" i]',
      '[aria-busy="true"]'
    ];
    const start = Date.now();
    return new Promise((resolve) => {
      (function poll() {
        const anyVisible = spinnerSelectors.some(
          (sel) => Array.from(document.querySelectorAll(sel)).some((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
        );
        if (!anyVisible || Date.now() - start > timeoutMs) return resolve();
        setTimeout(poll, 200);
      })();
    });
  }
  async function autoScrollForInfiniteList(maxScrolls = 6) {
    let lastHeight = 0;
    for (let i = 0; i < maxScrolls; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 700));
      const newHeight = document.body.scrollHeight;
      if (newHeight === lastHeight) break;
      lastHeight = newHeight;
    }
    window.scrollTo(0, 0);
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handleMessage(msg).then(sendResponse).catch((err) => {
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
    return true;
  });
  async function handleMessage(msg) {
    if (!parser) {
      return { ok: false, error: "No parser registered for this site." };
    }
    switch (msg.type) {
      case "PING":
        return { ok: true, pageType: parser.pageType(location.href) };
      case "CHECK_BLOCKER": {
        const blocked = parser.detectBlocker ? parser.detectBlocker(document) : false;
        return { ok: true, blocked };
      }
      case "COLLECT_LISTING_LINKS": {
        await waitForSpinnerGone();
        if (msg.supportInfiniteScroll) await autoScrollForInfiniteList();
        await waitForDomQuiet();
        const links = parser.collectListingLinks(document);
        const pagination = parser.detectPagination(document, location.href);
        return { ok: true, links, pagination };
      }
      case "GET_RESULTS_COUNT": {
        await waitForSpinnerGone();
        await waitForDomQuiet(400, 4e3);
        const count = parser.getResultsCount ? parser.getResultsCount(document) : null;
        return { ok: true, count };
      }
      case "GET_PRICE_BOUNDS": {
        await waitForSpinnerGone();
        await waitForDomQuiet(400, 4e3);
        const bounds = parser.getPriceBounds ? parser.getPriceBounds(document) : null;
        return { ok: true, bounds };
      }
      case "EXTRACT_SEARCH_LISTINGS": {
        await waitForSpinnerGone();
        await waitForDomQuiet(400, 4e3);
        const listings = parser.extractSearchPageListings ? parser.extractSearchPageListings(document) : [];
        return { ok: true, listings };
      }
      case "EXTRACT_LISTING": {
        await waitForDomQuiet(50, 500);
        const startTime = performance.now();
        const listing = parser.extractListing(document, location.href);
        listing.scrape_time_ms = Math.round(performance.now() - startTime);
        listing.scrape_status = "success";
        if (msg.settings?.enableRawHtml) {
          listing.raw_html = document.documentElement.outerHTML.slice(0, 5e5);
        }
        return { ok: true, listing };
      }
      default:
        return { ok: false, error: `Unknown message type: ${msg.type}` };
    }
  }
})();
