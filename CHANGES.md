# Automatic Dynamic Price Range Segmentation — July 14, 2026

Implements the full spec: retrieve 100% of a search's listings even when it
has far more results than a single query can page through, by
automatically slicing the search into price bands — no manual price-range
editing required.

## What changed

**`parser/bayut.js`** — added the three exports auto-split needs
(`getResultsCount`, `getPriceBounds`, `buildPriceFilteredUrl`). Bayut is
the primary/verified site and previously had none of these, so clicking
"Auto-Split & Scrape" on a Bayut page failed immediately with "Auto-split
isn't wired up for this site yet" — the batch/bisection engine already
existed (`background/service-worker.js`) but had nothing to call on the
one site actually built for production use. Same caveat as the rest of
this parser: the query param names (`price_min`/`price_max`) and
`__NEXT_DATA__` key names are best-effort inference, not confirmed
against a live render — verify with a small test slice before a full run.

**`background/service-worker.js`** — replaced the old fixed-depth
bisection (`bisect(0, ceiling, depth)`, always split exactly in half, no
check of the unfiltered total first) with the algorithm the spec actually
describes:
1. Probe the *original, unfiltered* search's total count first. At or
   under the threshold (default 900) → scrape it directly, no split at
   all.
2. Otherwise, detect the real lowest/highest listing price when the site
   supports it (`getPriceBounds`), falling back to configured
   floor/ceiling.
3. Walk the price axis from real low to real high, carving off the
   *widest* safe band at each step via exponential-growth probing +
   binary search — never a fixed AED increment. A band that came back
   comfortably under the cap makes the next band's starting guess wider
   (sparse stretch); a band that needed narrowing keeps it similar
   (dense stretch). A single exact price shared by more listings than
   the cap is kept as one oversized slice (can't be split further by
   price) with a warning logged.

Merging + deduplication across every slice was already correct — listings
are keyed by `listing_id` (site reference number, or a hash of the URL as
fallback) in `storage/db.js`, and batch slices are never cleared between
each other — so this didn't need to change.

**`config/defaults.js`** — `autoSplitListingThreshold` default changed
from 1450 to 900 to match the spec; added `autoSplitPriceFloor`,
`autoSplitMinRangeWidthAed` (granularity floor for the binary search), and
`autoSplitProbeLimit` (safety cap on total page-loads spent segmenting).

**`content/content-script.js`** — added a `GET_PRICE_BOUNDS` message
handler alongside the existing `GET_RESULTS_COUNT` one.

**`parser/parser-interface.js`** — documented the three optional
price-segmentation exports so a future site parser (PropertyFinder,
Zillow) can implement them the same way.

**`popup/popup.html` / `popup/popup.js`** — added a Settings sub-section
to tune the threshold and floor/ceiling without editing code.

## Verifying it

The "Auto-Split & Scrape" button (already present in the popup — no new
UI entry point needed) now runs the full workflow end to end on Bayut.
Watch the Live Logs tab: it logs the total count check, the detected or
configured price range, each accepted slice with its actual listing
count, and the final "N slices generated after M probes" summary before
the batch scrape starts.

---

# Fixes applied — July 13, 2026

Your two exported sheets (Bayut + PropertyFinder) showed almost every column
empty except title/description. Here's exactly what was wrong and what
changed, file by file.

## 1. Bayut — the big one (parser/bayut.js)

Every Bayut row's real data (bedrooms, bathrooms, size, price, property
type, purpose, community, agency) is pulled by reading a sentence like:

  "1-bed, 1-bath, 640 sqft apartment for rent at Noor Apartment 1,
   JVT District 2 for AED 59,998 yearly, listed by Oscar Real Estate.
   View floor plan, amenities & more."

The old regex expected the price to end in "/year" (a slash) and expected
the sentence to stop right after the agency name. Real Bayut text uses the
word "yearly" (no slash), and always adds an extra sentence afterwards
("View floor plan..."). Both of those mismatches made the pattern fail on
100% of your rows — that's why every derived column was blank.

Fixed to accept "yearly"/"monthly" as words, and to stop the agency capture
at the next period instead of demanding end-of-string. Also: rent listings
now write their amount into `annual_rent_aed` instead of `price_aed`
(previously rent amounts weren't written anywhere).

## 2. PropertyFinder — property_type was reading the wrong data (parser/propertyfinder.js)

The parser searched PropertyFinder's page data for any key literally named
"type" — but that name is common inside a big data tree and it was matching
an unrelated internal flag, not the actual property type, which is why
every row showed "list" in that column.

Fixed by removing the generic "type" key, and adding two reliable sources
instead: the listing URL itself (e.g. ".../apartment-for-sale-dubai-..."
directly tells you property_type=Apartment, purpose=Sale — no parsing
needed) and the description sentence ("788 sqft Apartment for sale...").
Also added the same rent-vs-sale price split as Bayut, and added
BUA / plot size / agency / agent / developer label-scanning (same technique
already used on Bayut) as fallbacks.

## 3. Amenities showing "[object Object]" on every row (utils/normalize.js)

Amenities/features come back from the page as a list of objects like
{name: "Balcony", icon: "..."}, not plain strings. The old code converted
each one straight to text, which for an object just produces the literal
string "[object Object]" — that's what was flooding that column. Fixed to
pull out the actual label from the object.

## 4. Rebuilt content-script.bundle.js

The extension's real code path is content/content-script.bundle.js, a
pre-built bundle listed in manifest.json — content-script.js is just the
readable source. All the fixes above only take effect after rebuilding the
bundle, so that's included in this zip (run build.sh again yourself only if
you edit the source further).

---

# Round 2 fixes — July 13, 2026 (from your latest test export)

Your fresh scrape showed the round-1 fixes working (most Bayut and
PropertyFinder columns now populate correctly). Two new bugs surfaced in
the actual data that round 1 couldn't have caught without seeing more rows:

## 5. Bayut villas came back completely empty (parser/bayut.js)

Apartments and villas turned out to use two differently-worded sentences:

  apartment: "...apartment for sale AT Rapunzel Tower, Living Legends
              FOR AED 1,650,000, listed by..."
  villa:     "...villa IS for sale IN Verdana 2, Dubai Investments Park
              (DIP) AT AED 1,218,000, listed by..."

Round 1's regex only matched the apartment wording, so every villa row
(purpose, community, property_type, bedrooms, bathrooms, size, price,
agency) came back null even though apartments worked fine. Verified against
all 18 rows of your latest Bayut export — every row (including all the
villa ones) now matches.

## 6. "developer" showing "[object Object]" on PropertyFinder (utils/normalize.js, parser/propertyfinder.js)

Same root problem as the amenities bug from round 1, just hit a different
field: PropertyFinder returns the developer as an object like
{name: "Emaar Properties", id: 123}, not a plain string, and it was being
converted straight to text without pulling the name out first. The
amenities fix only covered *arrays* of these objects — this field is a
single object, so it slipped through. Fixed by making the same
"unwrap the label" logic (renamed to `normalizeLabel`) reusable for any
single field, not just arrays, and applied it to developer/agency/agent_name
on both parsers so this can't resurface on a different field again.

## What's still best-effort, not guaranteed

BUA, plot size, agency, and agent name are pulled either from __NEXT_DATA__
key names or by scanning the page for a label like "BUA" / "Agent" next to
its value. I can't render Bayut/PropertyFinder's live JavaScript from here,
so these are my best inference, not something I clicked through and
confirmed today. Same goes for `developer` — it's usually genuinely absent
on secondary-market (non-off-plan) listings, so a blank developer column on
a resale unit is often correct, not a bug. Run the extension on a live page
and check these specific columns — if any come back empty on a listing
where you can see the value on the page, send me a screenshot of that one
row's HTML (right-click the label → Inspect) and I'll patch the selector.
