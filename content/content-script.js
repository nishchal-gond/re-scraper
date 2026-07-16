// content/content-script.js
// Injected into every matched page. Does nothing until the background
// service worker sends it a message — it never scrapes proactively, so
// just browsing the site with the extension installed doesn't do anything.

import { getParserForUrl } from "../parser/registry.js";

const parser = getParserForUrl(location.href);

// --- Wait helpers: "wait for network idle" / "wait for AJAX completion" ---
// A real network-idle detector needs the background worker (content scripts
// can't see network events directly), so this content script's job is the
// DOM-side half: wait for visible loading spinners to disappear and for
// the DOM to stop mutating for a short quiet window.
function waitForDomQuiet(quietMs = 600, timeoutMs = 8000) {
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

function waitForSpinnerGone(timeoutMs = 8000) {
  const spinnerSelectors = [
    '[class*="spinner" i]',
    '[class*="loading" i]',
    '[aria-busy="true"]',
  ];
  const start = Date.now();
  return new Promise((resolve) => {
    (function poll() {
      const anyVisible = spinnerSelectors.some((sel) =>
        Array.from(document.querySelectorAll(sel)).some((el) => {
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
    if (newHeight === lastHeight) break; // no new content loaded, stop early
    lastHeight = newHeight;
  }
  window.scrollTo(0, 0);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });
  return true; // keep the message channel open for the async response
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
      // Optional parser export — sites that don't implement it (or where
      // the current selector doesn't match) just return null, and the
      // caller falls back to a slower page-probe method.
      await waitForSpinnerGone();
      await waitForDomQuiet(400, 4000);
      const count = parser.getResultsCount ? parser.getResultsCount(document) : null;
      return { ok: true, count };
    }

    case "GET_PRICE_BOUNDS": {
      // Optional parser export — sites that don't implement it just
      // return null, and the caller falls back to configured
      // floor/ceiling settings instead of the real data range.
      await waitForSpinnerGone();
      await waitForDomQuiet(400, 4000);
      const bounds = parser.getPriceBounds ? parser.getPriceBounds(document) : null;
      return { ok: true, bounds };
    }

    case "EXTRACT_SEARCH_LISTINGS": {
      await waitForSpinnerGone();
      await waitForDomQuiet(400, 4000);
      const listings = parser.extractSearchPageListings ? parser.extractSearchPageListings(document) : [];
      return { ok: true, listings };
    }

    case "EXTRACT_LISTING": {
      // Listing pages are server-rendered (Bayut/Next.js SSR) — the
      // JSON-LD and __NEXT_DATA__ blocks we actually read are present in
      // the initial HTML, not injected later by client JS. The heavy
      // spinner/mutation-quiet wait used for search pages (which do need
      // to wait for infinite-scroll content) just burns time here for no
      // benefit. A short, cheap settle is enough.
      await waitForDomQuiet(50, 500);
      const startTime = performance.now();
      const listing = parser.extractListing(document, location.href);
      listing.scrape_time_ms = Math.round(performance.now() - startTime);
      listing.scrape_status = "success";
      if (msg.settings?.enableRawHtml) {
        listing.raw_html = document.documentElement.outerHTML.slice(0, 500000); // hard cap, safety
      }
      return { ok: true, listing };
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}
