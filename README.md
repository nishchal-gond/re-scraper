# RE Scraper Pro

A Chrome (Manifest V3) extension that scrapes multi-page real estate search
results — collects listing links, visits each one, extracts structured
fields, and exports everything to Excel/CSV/JSON. One button starts it.

**Read this whole README before running a real scrape.** The "Reality Check"
section near the bottom matters as much as the install steps.

---

## 1. Install (Load Unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (`re-scraper/`).
4. Pin the extension from the puzzle-piece icon so it's visible in the toolbar.

No build step is required to install — `content/content-script.bundle.js`
is already built. You only need to run `./build.sh` again if you edit
`content/content-script.js` or anything it imports (`parser/`, `utils/`).
Requires Node.js + `npm install` once if you plan to edit and rebuild.

## 2. Use it

1. Go to a **Bayut** search-results page, e.g.
   `https://www.bayut.com/to-rent/apartments/dubai/`.
2. Click the extension icon → **Start Scraping**.
3. Watch progress in the popup: current page, listings scraped/remaining,
   success/error/retry counts, and the live log tab.
4. When done (or whenever you want a partial export), go to the **Export**
   tab and click **Export Excel (.xlsx)**.

Pause/Resume/Stop work at any time. Stopping keeps everything already
collected — nothing is lost. Data persists in the browser's IndexedDB, so
closing the popup (even closing Chrome) doesn't lose progress; reopening
the popup and clicking Resume continues from the stored queue.

## 3. Settings (popup → Settings tab)

| Setting | What it does |
|---|---|
| Max pages | Hard cap on search-result pages visited, regardless of site size |
| End page | Stop at a specific page number (blank = go to the last page detected) |
| Concurrency | How many listing tabs open at once (clamped to 1–4) |
| Delay between listings | Pause before/after each listing tab (clamped to ≥500ms) |
| Retry attempts | How many times a failed listing/page is retried before being marked failed |
| Store raw HTML | Off by default — see "Why raw_html is opt-in" below |
| Append vs overwrite | Whether a new scrape adds to existing stored data or you clear first |

Concurrency and delay have hard ceilings in `config/defaults.js`
(`HARD_LIMITS`) that the UI can't exceed. This is intentional — see below.

## 4. Architecture

```
manifest.json           MV3 manifest
background/
  service-worker.js     Orchestration: state machine, tab lifecycle, queue draining,
                         pause/resume/stop, resume-after-restart
content/
  content-script.js     Source (uses ES imports)
  content-script.bundle.js  Built artifact actually loaded by the browser (see build.sh)
parser/
  parser-interface.js   The contract every site module implements
  bayut.js               ✅ primary target, structure-verified (see Reality Check)
  propertyfinder.js       ⚠ scaffold, NOT verified against live DOM
  zillow.js                ⚠ scaffold, NOT verified against live DOM, ToS caveat
  registry.js            Adding a new site = one new file + one line here
storage/
  db.js                  IndexedDB (via Dexie) — listings, URL queue, page log, event log
export/
  exporter.js             xlsx/csv/json export via bundled SheetJS
models/
  listing-schema.js      Canonical field list every listing row conforms to
utils/
  normalize.js            Number/price/date/boolean normalization, dedupe key
  structured-data.js      JSON-LD / __NEXT_DATA__ / OpenGraph extraction helpers
popup/                   UI: start/pause/resume/stop, progress, settings, export
options/                 Minimal — real settings live in the popup, not duplicated here
config/
  defaults.js             Default settings + hard safety limits
libs/                    Vendored SheetJS + Dexie (bundled locally; MV3 CSP blocks remote scripts)
```

### Why JSON-LD / `__NEXT_DATA__` first, CSS selectors last

Real estate sites redesign their markup often — CSS class names churn on
every deploy. Most of them (Bayut and PropertyFinder both run on Next.js)
embed the same data their React components render from as JSON, either in
a `<script type="application/ld+json">` tag (schema.org markup, there for
Google's benefit) or in `#__NEXT_DATA__`. Reading that JSON directly is far
more durable than chasing `div[class="sc-8f7a2b1"]`-style selectors, which
is why every parser tries structured data first and falls back to CSS only
for the few fields structured data doesn't carry.

### Why `raw_html` is opt-in, not default

The original spec's field list included `raw_html` per row. Storing full
page HTML for thousands of listings will balloon IndexedDB into hundreds
of MB and slow every subsequent export. It's off by default; turn it on in
Settings if you specifically need it, and it's capped at 500KB/listing
even when enabled.

### Why it's faster now (tab pool)

Earlier versions opened a brand-new tab per listing and destroyed it right
after — tab process creation/teardown was costing real time (several
hundred ms to ~1s) per listing for no actual benefit, since a listing tab
doesn't need process isolation from the last one. It now keeps a small
pool of tabs open (sized to `concurrency`) and reuses them by navigating
(`chrome.tabs.update`) instead of recreating. Listing-page extraction also
no longer waits for spinners/DOM-mutation-quiet the way search-page
collection does — Bayut's listing pages are server-rendered, so the
JSON-LD/`__NEXT_DATA__` we read is already in the initial HTML.

If it's still too slow for your patience: raise **Concurrency** to 3–4 in
Settings (hard-capped there on purpose) and lower **Delay between
listings** toward the 500ms floor. Just know you're trading it against
"less likely to get bot-detected" — Bayut runs bot detection, and this
extension makes no attempt to bypass it, only to detect and pause. If you
see the "Blocked" status appear more often after speeding up, that's the
signal to dial concurrency/delay back down.

### Why concurrency and delay are clamped

"Open multiple tabs in parallel" and "maximum speed" are in tension with
"don't get the user's IP blocked." Real estate sites (Bayut explicitly)
run bot detection. Rather than picking a number that looks fast in a demo
and gets you rate-limited on listing 200, the defaults are conservative
(concurrency 2, 1.5s delay) and the hard ceiling is concurrency 4 / 500ms
minimum delay — loosenable in `config/defaults.js` if you accept the risk,
but not something the UI will let you disable entirely.

## 5. Fault tolerance / resume, concretely

- Every successfully scraped listing is written to IndexedDB immediately —
  not batched, not held in memory until the end.
- The URL queue (pending/in-progress/done/failed) is also in IndexedDB.
- MV3 kills idle service workers after ~30s. A `chrome.alarms` tick every
  ~24s wakes it back up while a scrape is `running`, and on any fresh
  worker start (browser restart included), if the last known session
  status was `running`, the engine picks the queue back up automatically —
  it doesn't restart from page 1.
- A failed listing is retried (`retryAttempts`, exponential-ish backoff)
  before being marked `failed` and logged with its error, not silently
  dropped.
- CAPTCHA / bot-check pages are detected (`detectBlocker` in each parser)
  and pause the whole session with a visible notice rather than scraping
  garbage from the interstitial page.

## 6. Reality Check — read before a full production run

**Bayut** (`parser/bayut.js`) is the one module I built with actual
knowledge of the site's public conventions — listing URLs follow
`/property/details-<id>.html`, it's Next.js-based, and it publishes
JSON-LD/Trakheesi permit data. I could not render Bayut's live JavaScript
in this sandbox (no headless browser available to me here), so the CSS
*fallback* selectors are my best inference, not something I clicked
through today. **Run a small test scrape (2–3 pages) and check the
exported spreadsheet for gaps before trusting a large run.**

**PropertyFinder** (`parser/propertyfinder.js`) and **Zillow**
(`parser/zillow.js`) are scaffolds — correct shape, same structured-data
strategy, but selectors are placeholders I have not verified against live
markup. Each file has a banner at the top telling you exactly what to
check and fix. Budget an hour or two per site to point-and-verify
selectors against real pages before relying on them.

**Zillow specifically**: their Terms of Use prohibit automated
scraping/crawling, and they run active bot detection. I included the
module because it was asked for, but for a real project touching Zillow
data I'd look at their official data licensing/API options instead of
scraping — that's a materially different risk profile than a site without
that clause.

**No CAPTCHA/Cloudflare bypass is implemented anywhere**, deliberately —
the extension detects and pauses for manual solving instead.

## 7. Extending to a new site

1. Copy `parser/propertyfinder.js` as a template.
2. Implement `matches`, `pageType`, `collectListingLinks`,
   `detectPagination`, `extractListing` (see `parser/parser-interface.js`
   for the exact contract).
3. Add the new site's domain to `host_permissions` and `content_scripts.matches`
   in `manifest.json`.
4. Register the module in `parser/registry.js`.
5. Run `./build.sh` to rebuild the content script bundle.
6. Reload the extension in `chrome://extensions`.

Nothing in `background/`, `storage/`, `export/`, or `popup/` needs to
change — that's the point of the parser interface.

## 8. Known gaps vs. the original spec (being upfront)

- React/TypeScript/Vite popup was requested; I built a plain HTML/CSS/JS
  popup instead so it runs with zero build step for the UI (only the
  content script needs bundling, and that's already done for you). If you
  want it in React specifically, say so and I'll port it — the logic in
  `popup.js` maps cleanly onto components.
- "Support Vue/Angular/SPA sites generically" — the JSON-LD/structured-data
  strategy works across frameworks, but each site still needs its own
  parser module verified against its real markup; there's no such thing as
  a truly zero-config universal real estate parser.
- Image download/embedding isn't implemented — `images_count` is captured
  where structured data exposes it, but files aren't downloaded.
