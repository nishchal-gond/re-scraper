// core/slicer.js
//
// Standalone reimplementation of the extension's dynamic price-range
// segmentation. Site I/O is supplied by the caller through probe callbacks,
// which keeps this module usable from Playwright and testable without a page.

export const DEFAULT_SLICER_SETTINGS = Object.freeze({
  listingThreshold: 900,
  priceFloor: 0,
  priceCeiling: null,
  minRangeWidthAed: 1000,
  probeLimit: 400,
  outlierMedianRatio: 8,
  maxOutliersPerRun: 2,
  minSegmentationCeiling: 300000,
});

/**
 * @typedef {{ url: string, price: number }} SearchListing
 * @typedef {{ min?: number|null, max?: number|null }} PriceBounds
 * @typedef {{
 *   baseUrl: string,
 *   buildPriceFilteredUrl: (baseUrl: string, minPrice: number|null, maxPrice: number|null) => string,
 *   probeCount: (url: string, context: {minPrice: number|null, maxPrice: number|null, probeNumber: number}) => Promise<number|null>,
 *   getResultsCount?: () => Promise<number|null>,
 *   getPriceBounds?: () => Promise<PriceBounds|null>,
 *   getDescendingListings?: () => Promise<SearchListing[]>,
 *   configuredFloor?: number|null,
 *   configuredCeiling?: number|null,
 *   settings?: Partial<typeof DEFAULT_SLICER_SETTINGS>,
 *   onEvent?: (event: {level: string, message: string, [key: string]: unknown}) => void,
 * }} SliceOptions
 */

/**
 * Produces ordered, inclusive price slices. A returned slice may exceed the
 * threshold only when all of its listings share one exact, unsplittable price.
 * @param {SliceOptions} options
 */
export async function generatePriceSlices(options) {
  validateOptions(options);
  const settings = { ...DEFAULT_SLICER_SETTINGS, ...(options.settings || {}) };
  const emit = options.onEvent || (() => {});
  const state = { probesRun: 0 };

  const totalCount = options.getResultsCount ? await options.getResultsCount() : null;
  if (Number.isFinite(totalCount) && totalCount <= settings.listingThreshold) {
    emit({ level: "info", message: `Unfiltered search has ${totalCount} listings; no price split is needed.` });
    return {
      mode: "unsliced",
      totalCount,
      probesRun: state.probesRun,
      floor: null,
      ceiling: null,
      outlierListings: [],
      slices: [{ id: 0, minPrice: null, maxPrice: null, count: totalCount, url: options.baseUrl }],
    };
  }

  let bounds = null;
  if (options.getPriceBounds) {
    try {
      bounds = await options.getPriceBounds();
    } catch (error) {
      emit({ level: "warn", message: `Could not determine observed price bounds: ${error.message || error}` });
    }
  }

  const outlierResult = await detectOutliers(options, settings, emit);
  const floor = chooseFloor(options.configuredFloor, bounds?.min, settings.priceFloor);
  const ceiling = chooseCeiling(options.configuredCeiling, outlierResult.segmentationCeiling, bounds?.max, settings.priceCeiling);
  if (!Number.isFinite(floor) || !Number.isFinite(ceiling) || ceiling < floor) {
    throw new Error(`Invalid effective price range: ${floor}–${ceiling}. Supply a valid floor/ceiling or fix price-bound extraction.`);
  }

  emit({ level: "info", message: `Effective price range: AED ${floor.toLocaleString()}–${ceiling.toLocaleString()}.` });
  const slices = [];
  let currentLo = floor;
  let nextStartWidth = Math.max(settings.minRangeWidthAed, Math.floor((ceiling - floor) / 20) || settings.minRangeWidthAed);

  while (currentLo <= ceiling) {
    if (state.probesRun >= settings.probeLimit) {
      const url = options.buildPriceFilteredUrl(options.baseUrl, currentLo, ceiling);
      slices.push(makeSlice(slices.length, currentLo, ceiling, null, url, { probeLimitFallback: true }));
      emit({ level: "warn", message: `Probe limit (${settings.probeLimit}) reached; queued remaining AED ${currentLo.toLocaleString()}–${ceiling.toLocaleString()} as one slice.` });
      break;
    }

    const band = await findWidestSafeBand({ options, settings, state, lo: currentLo, hiLimit: ceiling, startWidth: nextStartWidth });
    if (band.count === 0) {
      currentLo = band.maxPrice + 1;
      nextStartWidth = Math.max(settings.minRangeWidthAed, nextStartWidth * 2);
      continue;
    }

    slices.push(makeSlice(slices.length, currentLo, band.maxPrice, band.count, band.url, { unsplittableExactPrice: band.unsplittableExactPrice }));
    const widthUsed = Math.max(settings.minRangeWidthAed, band.maxPrice - currentLo);
    nextStartWidth = band.count < settings.listingThreshold * 0.5 ? widthUsed * 2 : widthUsed;
    currentLo = band.maxPrice + 1;
  }

  return {
    mode: "sliced",
    totalCount,
    probesRun: state.probesRun,
    floor,
    ceiling,
    outlierListings: outlierResult.outliers,
    slices,
  };
}

async function findWidestSafeBand({ options, settings, state, lo, hiLimit, startWidth }) {
  const exact = await probe(options, state, lo, lo);
  if (exact.count === null) throw new Error(`Failed to read result count for exact price AED ${lo}.`);
  if (exact.count > settings.listingThreshold) {
    return { maxPrice: lo, count: exact.count, url: exact.url, unsplittableExactPrice: true };
  }

  let valid = exact;
  let invalidPrice = null;
  let width = Math.max(startWidth, settings.minRangeWidthAed);
  let candidate = Math.min(hiLimit, lo + width);

  while (state.probesRun < settings.probeLimit) {
    const candidateResult = await probe(options, state, lo, candidate);
    if (candidateResult.count === null) throw new Error(`Failed to read result count for AED ${lo}–${candidate}.`);
    if (candidateResult.count > settings.listingThreshold) {
      invalidPrice = candidate;
      break;
    }
    valid = candidateResult;
    if (candidate >= hiLimit) return { maxPrice: hiLimit, count: valid.count, url: valid.url, unsplittableExactPrice: false };
    width *= 2;
    candidate = Math.min(hiLimit, lo + width);
  }

  if (invalidPrice === null) return { maxPrice: valid.maxPrice, count: valid.count, url: valid.url, unsplittableExactPrice: false };

  let lowSafe = valid.maxPrice;
  let highUnsafe = invalidPrice;
  while (highUnsafe - lowSafe > settings.minRangeWidthAed && state.probesRun < settings.probeLimit) {
    const middle = Math.floor((lowSafe + highUnsafe) / 2);
    const result = await probe(options, state, lo, middle);
    if (result.count === null) throw new Error(`Failed to read result count for AED ${lo}–${middle}.`);
    if (result.count <= settings.listingThreshold) {
      valid = result;
      lowSafe = middle;
    } else {
      highUnsafe = middle;
    }
  }
  return { maxPrice: valid.maxPrice, count: valid.count, url: valid.url, unsplittableExactPrice: false };
}

async function probe(options, state, minPrice, maxPrice) {
  state.probesRun += 1;
  const url = options.buildPriceFilteredUrl(options.baseUrl, minPrice, maxPrice);
  const count = await options.probeCount(url, { minPrice, maxPrice, probeNumber: state.probesRun });
  return { minPrice, maxPrice, count: Number.isFinite(count) ? count : null, url };
}

async function detectOutliers(options, settings, emit) {
  if (!options.getDescendingListings) return { outliers: [], segmentationCeiling: null };
  let listings;
  try {
    listings = await options.getDescendingListings();
  } catch (error) {
    emit({ level: "warn", message: `Outlier check skipped: ${error.message || error}` });
    return { outliers: [], segmentationCeiling: null };
  }
  const valid = (listings || []).filter((item) => item && Number.isFinite(item.price) && item.price > 0 && typeof item.url === "string");
  if (valid.length <= 1) return { outliers: [], segmentationCeiling: null };

  const ascending = valid.map((item) => item.price).sort((a, b) => a - b);
  const median = medianOfSorted(ascending);
  const outliers = valid.filter((item) => item.price / median > settings.outlierMedianRatio);
  if (outliers.length === 0 || outliers.length / valid.length > 0.15 || outliers.length > settings.maxOutliersPerRun) {
    return { outliers: [], segmentationCeiling: null };
  }

  const nonOutliers = valid.filter((item) => item.price / median <= settings.outlierMedianRatio).sort((a, b) => b.price - a.price);
  const segmentationCeiling = nonOutliers[0]?.price ?? null;
  if (!Number.isFinite(segmentationCeiling) || segmentationCeiling < settings.minSegmentationCeiling) {
    return { outliers: [], segmentationCeiling: null };
  }
  emit({ level: "info", message: `Detected ${outliers.length} extreme price outlier(s); their listing URLs will be processed directly.` });
  return { outliers, segmentationCeiling };
}

function chooseFloor(configuredFloor, observedFloor, defaultFloor) {
  const configured = finitePositiveOrZero(configuredFloor);
  if (configured !== null && configured > 0) return Math.max(configured, finitePositiveOrZero(observedFloor) || 0);
  return finitePositiveOrZero(observedFloor) ?? finitePositiveOrZero(defaultFloor) ?? 0;
}

function chooseCeiling(configuredCeiling, outlierCeiling, observedCeiling, defaultCeiling) {
  for (const candidate of [configuredCeiling, outlierCeiling, observedCeiling, defaultCeiling]) {
    const value = finitePositiveOrZero(candidate);
    if (value !== null && value > 0) return value;
  }
  return null;
}

function makeSlice(id, minPrice, maxPrice, count, url, extra) {
  return { id, minPrice, maxPrice, count, url, ...extra };
}

function medianOfSorted(values) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function finitePositiveOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validateOptions(options) {
  if (!options || typeof options.baseUrl !== "string" || !options.baseUrl) throw new Error("baseUrl is required.");
  if (typeof options.buildPriceFilteredUrl !== "function") throw new Error("buildPriceFilteredUrl callback is required.");
  if (typeof options.probeCount !== "function") throw new Error("probeCount callback is required.");
}
