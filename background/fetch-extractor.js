// background/fetch-extractor.js

function createMockDocument(htmlText) {
  return {
    body: {
      get innerText() {
        return htmlText;
      }
    },
    getElementById(id) {
      if (id === "__NEXT_DATA__") {
        const match = htmlText.match(/<script\s+[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (match) {
          return { textContent: match[1] };
        }
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'script[type="application/ld+json"]') {
        const blocks = [];
        const regex = /<script\s+[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        while ((match = regex.exec(htmlText)) !== null) {
          blocks.push({ textContent: match[1] });
        }
        return blocks;
      }
      return [];
    },
    querySelector(selector) {
      if (selector.startsWith('meta[')) {
        const nameMatch = selector.match(/(?:name|property)="([^"]+)"/);
        if (nameMatch) {
          const propName = nameMatch[1];
          const metaRegex = new RegExp(`<meta\\s+[^>]*(?:name|property)="${propName}"[^>]*content="([^"]*)"|<meta\\s+[^>]*content="([^"]*)"[^>]*(?:name|property)="${propName}"`, "i");
          const m = htmlText.match(metaRegex);
          if (m) {
            const val = m[1] || m[2] || "";
            return { getAttribute: (attr) => (attr === "content" ? val : null) };
          }
        }
      }
      if (selector === 'link[rel="canonical"]') {
        const m = htmlText.match(/<link\s+[^>]*rel="canonical"[^>]*href="([^"]*)"/i);
        if (m) {
          return { getAttribute: (attr) => (attr === "href" ? m[1] : null) };
        }
      }
      if (selector === "h1") {
        const m = htmlText.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (m) {
          return { textContent: m[1].replace(/<[^>]*>/g, "").trim() };
        }
      }
      return null;
    }
  };
}

export async function tryFetchExtract(url, parserModule) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch(url, {
      credentials: "include",
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (resp.status !== 200) {
      return null;
    }
    const htmlText = await resp.text();

    const mockDocForBlocker = {
      body: {
        get innerText() {
          return htmlText.slice(0, 2000);
        }
      }
    };
    if (parserModule.detectBlocker && parserModule.detectBlocker(mockDocForBlocker)) {
      return null;
    }

    const hasNextData = htmlText.includes('id="__NEXT_DATA__"');
    const hasJsonLd = htmlText.includes('type="application/ld+json"');
    if (!hasNextData && !hasJsonLd) {
      return null;
    }

    const mockDoc = createMockDocument(htmlText);
    const originalDoc = globalThis.document;
    try {
      globalThis.document = mockDoc;
      const listing = parserModule.extractListing(mockDoc, url);
      if (listing && listing.listing_id) {
        return listing;
      }
    } finally {
      globalThis.document = originalDoc;
    }
  } catch (e) {
    // Fail silently
  } finally {
    clearTimeout(timeoutId);
  }
  return null;
}
