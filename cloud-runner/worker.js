// cloud-runner/worker.js
// GitHub Actions-only PropertyFinder worker. Invoke with --prepare to create
// static slice assignments, or --worker to process one immutable assignment.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { DefaultArtifactClient } from "@actions/artifact";
import { buildPriceFilteredUrl, buildSortedPriceDescendingUrl, extractPageData, isPropertyFinderUrl } from "../core/parser.js";
import { generatePriceSlices } from "../core/slicer.js";
import { createFirstSeenDeduper } from "../core/dedupe.js";

const CHECKPOINT_VERSION = 1;
const ARTIFACT_PREFIX = "re-scraper-checkpoint";
const OUTPUT_ROOT = process.env.RUNNER_TEMP || ".cloud-runner";
const CONFIG = {
  listingConcurrency: integerEnv("LISTING_CONCURRENCY", 1, 1, 2),
  requestDelayMs: integerEnv("REQUEST_DELAY_MS", 1500, 500, 60_000),
  retries: integerEnv("RETRY_ATTEMPTS", 3, 0, 10),
  hardPricePerSqft: integerEnv("HARD_PRICE_PER_SQFT", 100000, 1, 1_000_000),
  maxPages: integerEnv("MAX_PAGES", 500, 1, 500),
  retentionDays: integerEnv("ARTIFACT_RETENTION_DAYS", 14, 1, 90),
};

let terminationRequested = false;
let currentPagePromise = null;
let publicationMutex = Promise.resolve();
let activeWorker = null;

process.on("SIGTERM", () => { terminationRequested = true; void flushOnTermination(); });
process.on("SIGINT", () => { terminationRequested = true; void flushOnTermination(); });

async function main() {
  const mode = process.argv.includes("--prepare") ? "prepare" : process.argv.includes("--worker") ? "worker" : null;
  if (!mode) throw new Error("Use --prepare or --worker.");
  if (mode === "prepare") return prepareManifest();
  return runWorker();
}

async function prepareManifest() {
  const baseUrl = requiredEnv("BASE_SEARCH_URL");
  const workerCount = integerEnv("WORKER_COUNT", 1, 1, 2);
  if (!isPropertyFinderUrl(baseUrl)) throw new Error("BASE_SEARCH_URL must be a PropertyFinder.ae URL.");
  const runKey = process.env.RUN_KEY || stableRunKey(baseUrl, process.env.PRICE_FLOOR, process.env.PRICE_CEILING);
  const artifactDir = join(OUTPUT_ROOT, "re-scraper", runKey, "manifest");
  await mkdir(join(artifactDir, "assignments"), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const go = async (url) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(750);
    const check = await page.evaluate(extractPageData, { mode: "blocker" });
    if (check.blocked) throw new Error("PropertyFinder bot/CAPTCHA page detected while preparing slices. Stopping cleanly.");
  };
  const probeCount = async (url) => {
    await go(url);
    return (await page.evaluate(extractPageData, { mode: "count" })).count;
  };
  try {
    await go(baseUrl);
    const result = await generatePriceSlices({
      baseUrl,
      buildPriceFilteredUrl,
      getResultsCount: async () => (await page.evaluate(extractPageData, { mode: "count" })).count,
      getPriceBounds: async () => (await page.evaluate(extractPageData, { mode: "bounds" })).bounds,
      getDescendingListings: async () => {
        await go(buildSortedPriceDescendingUrl(baseUrl));
        return (await page.evaluate(extractPageData, { mode: "search" })).listings;
      },
      probeCount,
      configuredFloor: optionalNumberEnv("PRICE_FLOOR"),
      configuredCeiling: optionalNumberEnv("PRICE_CEILING"),
      settings: {
        listingThreshold: integerEnv("LISTING_THRESHOLD", 900, 1, 100_000),
        priceCeiling: optionalNumberEnv("PRICE_CEILING"),
        priceFloor: optionalNumberEnv("PRICE_FLOOR") ?? 0,
      },
      onEvent: (event) => console.log(JSON.stringify({ component: "slicer", ...event })),
    });

    const directOutliers = result.outlierListings.map((item) => ({ url: item.url, source: "outlier-direct" }));
    let slices = result.slices.map((slice) => ({
      id: slice.id,
      min_price: slice.minPrice,
      max_price: slice.maxPrice,
      search_url: slice.url,
      listing_count_probe: slice.count,
      unsplittable_exact_price: Boolean(slice.unsplittableExactPrice),
      probe_limit_fallback: Boolean(slice.probeLimitFallback),
      assigned_worker_id: slice.id % workerCount,
    }));
    if (process.env.TEST_MODE === "true") {
      const target = integerEnv("TEST_LISTING_TARGET", 50, 1, 900);
      const candidates = slices.filter((slice) => Number.isFinite(slice.listing_count_probe) && slice.listing_count_probe <= target);
      if (!candidates.length) throw new Error(`Test mode could not identify a slice at or below the ${target}-listing target.`);
      candidates.sort((left, right) => right.listing_count_probe - left.listing_count_probe || left.id - right.id);
      slices = [{ ...candidates[0], id: 0, assigned_worker_id: 0 }];
      directOutliers.length = 0;
      console.log(`::notice title=Test slice selected::count=${slices[0].listing_count_probe}; min=${slices[0].min_price}; max=${slices[0].max_price}`);
    }
    const manifest = {
      version: 1, run_key: runKey, source_site: "propertyfinder", base_search_url: baseUrl,
      worker_count: workerCount, created_at: new Date().toISOString(), slicing: result,
      direct_outliers: directOutliers, slices,
    };
    await atomicJson(join(artifactDir, "slices.json"), manifest);
    for (let workerId = 0; workerId < workerCount; workerId += 1) {
      const assignment = {
        version: 1, run_key: runKey, worker_id: workerId, worker_count: workerCount,
        assigned_slice_ids: slices.filter((slice) => slice.assigned_worker_id === workerId).map((slice) => slice.id),
        slices: slices.filter((slice) => slice.assigned_worker_id === workerId),
        direct_outliers: workerId === 0 ? directOutliers : [],
      };
      await atomicJson(join(artifactDir, "assignments", `worker-${workerId}.json`), assignment);
    }
    console.log(`::notice title=Slice manifest ready::run_key=${runKey}; slices=${slices.length}; workers=${workerCount}`);
  } finally {
    await browser.close();
  }
}

async function runWorker() {
  const assignmentPath = requiredEnv("ASSIGNMENT_FILE");
  const assignment = JSON.parse(await readFile(assignmentPath, "utf8"));
  validateAssignment(assignment);
  const checkpointDir = join(OUTPUT_ROOT, "re-scraper", assignment.run_key, `worker-${assignment.worker_id}`);
  await mkdir(checkpointDir, { recursive: true });
  const artifactClient = new CheckpointArtifactClient({ assignment, checkpointDir });
  const restored = await artifactClient.downloadLatest();
  const state = restored || newCheckpoint(assignment);
  activeWorker = { state, artifactClient, checkpointDir };
  const deduper = createFirstSeenDeduper(state.completed_listing_ids);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const searchPage = await context.newPage();
  const parserPage = await context.newPage();
  try {
    if (!state.completed_slice_ids.includes(-1) && assignment.direct_outliers?.length) {
      await scrapeDirectOutliers({ state, assignment, deduper, artifactClient, context, parserPage });
    }
    for (const slice of assignment.slices) {
      if (terminationRequested || state.status === "blocked") break;
      if (state.completed_slice_ids.includes(slice.id)) continue;
      await scrapeSlice({ state, slice, deduper, artifactClient, context, searchPage, parserPage });
    }
    if (!terminationRequested && state.status !== "blocked" && assignment.assigned_slice_ids.every((sliceId) => state.completed_slice_ids.includes(sliceId))) {
      state.status = "complete";
      state.slice = { ...state.slice, completed: true };
      await artifactClient.publishFinal(state);
    }
  } finally {
    await browser.close();
  }
}

async function scrapeDirectOutliers({ state, assignment, deduper, artifactClient, context, parserPage }) {
  const pageRecords = [];
  state.status = "running";
  state.pending_listing_urls = assignment.direct_outliers.map((item) => ({ url: item.url, attempts: 0, discovered_on_page: 1 }));
  for (const item of assignment.direct_outliers) {
    if (terminationRequested) return;
    const extracted = await extractListingFetchFirst({ context, parserPage, url: item.url });
    if (extracted.blocked) { await stopBlocked(state, artifactClient, `Bot/CAPTCHA page detected on outlier ${item.url}.`); return; }
    if (!extracted.listing) await recordFailure(state, item.url, 0, extracted.error || "outlier extraction failed");
    else {
      if (deduper.accept(extracted.listing).accepted) pageRecords.push(extracted.listing);
      state.pending_listing_urls = state.pending_listing_urls.filter((entry) => entry.url !== item.url);
    }
    await sleep(CONFIG.requestDelayMs);
  }
  state.completed_listing_ids = deduper.snapshot();
  state.completed_slice_ids = uniqueNumbers([...state.completed_slice_ids, -1]);
  state.slice = { id: -1, min_price: null, max_price: null, search_url: null, listing_count_probe: assignment.direct_outliers.length, current_page: 1, next_page: 1, completed: true };
  state.sequence += 1;
  await artifactClient.publishCheckpoint(state, pageRecords, { sliceId: -1, pageNumber: 1 });
}
async function scrapeSlice({ state, slice, deduper, artifactClient, context, searchPage, parserPage }) {
  let pageNumber = state.slice?.id === slice.id ? state.slice.next_page : 1;
  let searchUrl = state.slice?.id === slice.id && state.slice.search_url ? state.slice.search_url : slice.search_url;
  state.status = "running";
  while (!terminationRequested && pageNumber <= CONFIG.maxPages) {
    currentPagePromise = scrapeOneSearchPage({ state, slice, pageNumber, searchUrl, deduper, artifactClient, context, searchPage, parserPage });
    const result = await currentPagePromise;
    currentPagePromise = null;
    if (result.blocked || result.finished) break;
    searchUrl = result.nextPageUrl;
    pageNumber += 1;
  }
  if (!terminationRequested && state.status !== "blocked") {
    state.completed_slice_ids = uniqueNumbers([...state.completed_slice_ids, slice.id]);
    state.slice = { ...state.slice, id: slice.id, min_price: slice.min_price, max_price: slice.max_price, search_url: searchUrl, listing_count_probe: slice.listing_count_probe, current_page: pageNumber, next_page: pageNumber, completed: true };
    state.status = "slice_complete";
    await artifactClient.publishCheckpoint(state, [], null);
  }
}

async function scrapeOneSearchPage({ state, slice, pageNumber, searchUrl, deduper, artifactClient, context, searchPage, parserPage }) {
  await searchPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await searchPage.waitForTimeout(750);
  const search = await searchPage.evaluate(extractPageData, { mode: "search", sourceUrl: searchUrl });
  if (search.blocked) return stopBlocked(state, artifactClient, `Bot/CAPTCHA page detected on search page ${pageNumber}.`);
  if (!search.links.length) return { finished: true, blocked: false, nextPageUrl: null };

  const pageRecords = [];
  state.pending_listing_urls = search.links.map((link) => ({ url: link.url, attempts: 0, discovered_on_page: pageNumber }));
  for (const link of search.links) {
    if (terminationRequested) break;
    const extracted = await extractListingFetchFirst({ context, parserPage, url: link.url });
    const pending = state.pending_listing_urls.find((item) => item.url === link.url);
    if (extracted.blocked) return stopBlocked(state, artifactClient, `Bot/CAPTCHA page detected on listing ${link.url}.`);
    if (!extracted.listing) {
      await recordFailure(state, link.url, pending?.attempts || 0, extracted.error || "extraction failed");
      continue;
    }
    const accepted = deduper.accept(extracted.listing);
    if (accepted.accepted) pageRecords.push(extracted.listing);
    state.pending_listing_urls = state.pending_listing_urls.filter((item) => item.url !== link.url);
    await sleep(CONFIG.requestDelayMs);
  }
  if (terminationRequested) return { finished: true, blocked: false, nextPageUrl: null };

  const nextPage = search.pagination.nextPageUrl;
  state.slice = {
    id: slice.id, min_price: slice.min_price, max_price: slice.max_price, search_url: searchUrl,
    listing_count_probe: slice.listing_count_probe, current_page: pageNumber, next_page: nextPage ? pageNumber + 1 : pageNumber,
    completed: !nextPage,
  };
  state.completed_listing_ids = deduper.snapshot();
  state.sequence += 1;
  await artifactClient.publishCheckpoint(state, pageRecords, { sliceId: slice.id, pageNumber });
  return { finished: !nextPage, blocked: false, nextPageUrl: nextPage };
}

async function extractListingFetchFirst({ context, parserPage, url }) {
  const startedAt = Date.now();
  for (let attempt = 0; attempt <= CONFIG.retries; attempt += 1) {
    try {
      const response = await context.request.get(url, { timeout: 20_000, failOnStatusCode: false });
      if (response.status() === 200) {
        const html = await response.text();
        if (html.includes('id="__NEXT_DATA__"') || html.includes('type="application/ld+json"')) {
          await parserPage.setContent(html, { waitUntil: "domcontentloaded", timeout: 20_000 });
          const parsed = await parserPage.evaluate(extractPageData, { mode: "listing", sourceUrl: url, hardPricePerSqft: CONFIG.hardPricePerSqft });
          if (parsed.blocked) return parsed;
          if (parsed.listing?.listing_id) return markListingSuccess(parsed, startedAt);
        }
      }
    } catch { /* browser-page fallback below */ }
    try {
      const fallback = await context.newPage();
      try {
        await fallback.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await fallback.waitForTimeout(300);
        const parsed = await fallback.evaluate(extractPageData, { mode: "listing", sourceUrl: url, hardPricePerSqft: CONFIG.hardPricePerSqft });
        if (parsed.blocked) return parsed;
        if (parsed.listing?.listing_id) return markListingSuccess(parsed, startedAt);
      } finally { await fallback.close(); }
    } catch (error) {
      if (attempt === CONFIG.retries) return { listing: null, blocked: false, error: String(error.message || error) };
    }
    await sleep(1_000 * (attempt + 1));
  }
  return { listing: null, blocked: false, error: "fetch and browser fallback failed" };
}

function markListingSuccess(result, startedAt) {
  result.listing.scrape_status = "success";
  result.listing.scrape_time_ms = Date.now() - startedAt;
  return result;
}
async function stopBlocked(state, artifactClient, message) {
  console.log(`::warning title=Worker blocked::${message}`);
  state.status = "blocked";
  state.sequence += 1;
  await artifactClient.publishCheckpoint(state, [], null);
  return { blocked: true, finished: true, nextPageUrl: null };
}

async function recordFailure(state, url, priorAttempts, error) {
  const retryCount = priorAttempts + 1;
  const existing = state.failed_urls.find((item) => item.url === url);
  const entry = { url, retry_count: retryCount, last_error: String(error), last_attempt_at: new Date().toISOString() };
  if (existing) Object.assign(existing, entry); else state.failed_urls.push(entry);
  state.pending_listing_urls = state.pending_listing_urls.filter((item) => item.url !== url);
}

class CheckpointArtifactClient {
  constructor({ assignment, checkpointDir }) {
    this.assignment = assignment;
    this.checkpointDir = checkpointDir;
    this.artifacts = new DefaultArtifactClient();
  }

  prefix() { return `${ARTIFACT_PREFIX}--${this.assignment.run_key}--w${this.assignment.worker_id}--`; }

  artifactName(state) {
    const sliceId = state.slice?.id ?? "final";
    const page = state.slice?.current_page ?? 0;
    return `${this.prefix()}s${sliceId}--p${page}--q${String(state.sequence).padStart(6, "0")}`;
  }

  async publishCheckpoint(state, records, pageInfo) {
    return this.withPublishLock(async () => {
      const artifactName = this.artifactName(state);
      const artifactDir = join(this.checkpointDir, `q${String(state.sequence).padStart(6, "0")}`);
      const segmentPath = pageInfo ? join(artifactDir, "segments", `worker-${state.worker_id}`, `slice-${pageInfo.sliceId}`, `page-${String(pageInfo.pageNumber).padStart(4, "0")}.ndjson`) : null;
      if (segmentPath) await atomicText(segmentPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
      const segment = segmentPath ? {
        slice_id: pageInfo.sliceId, page: pageInfo.pageNumber, artifact_name: artifactName, artifact_id: null,
        path: relativeArtifactPath(segmentPath, artifactDir), sha256: await fileSha256(segmentPath), record_count: records.length,
      } : null;
      if (segment) state.output.segments.push(segment);
      state.output.current_segment_path = segment?.path || state.output.current_segment_path;
      state.updated_at = new Date().toISOString();
      // Artifact ID/digest are unknowable until upload finalization. The stored
      // checkpoint records null for its own artifact; restore hydrates these
      // fields from the finalized artifact metadata before continuing.
      state.publication = { artifact_name: artifactName, artifact_id: null, artifact_digest: null, published_at: state.updated_at };
      const checkpointPath = join(artifactDir, "checkpoint.json");
      await atomicJson(checkpointPath, state);
      let uploaded;
      try {
        uploaded = await this.artifacts.uploadArtifact(artifactName, segmentPath ? [checkpointPath, segmentPath] : [checkpointPath], artifactDir, { retentionDays: CONFIG.retentionDays });
      } catch (error) {
        state.status = "publish_failed";
        throw new Error(`Checkpoint upload failed for sequence ${state.sequence}: ${error.message || error}`);
      }
      state.publication = {
        artifact_name: artifactName,
        artifact_id: uploaded.id,
        artifact_digest: uploaded.digest || null,
        published_at: new Date().toISOString(),
      };
      if (segment) segment.artifact_id = uploaded.id;
      console.log(`::notice title=Checkpoint published::artifact=${artifactName}; id=${uploaded.id}; sequence=${state.sequence}; next_page=${state.slice?.next_page}`);
      return uploaded;
    });
  }

  async publishFinal(state) {
    state.sequence += 1;
    return this.publishCheckpoint(state, [], null);
  }

  async downloadLatest() {
    const artifacts = await listArtifacts(this.prefix());
    const valid = [];
    for (const artifact of artifacts) {
      const target = join(this.checkpointDir, "restore", String(artifact.id));
      try {
        await downloadAndExtractArtifact(artifact.id, target);
        const checkpoint = JSON.parse(await readFile(join(target, "checkpoint.json"), "utf8"));
        if (!validCheckpoint(checkpoint, this.assignment, artifact)) continue;
        await validateCurrentSegment(checkpoint, target);
        checkpoint.publication = { artifact_name: artifact.name, artifact_id: artifact.id, artifact_digest: artifact.digest || null, published_at: artifact.created_at };
        for (const segment of checkpoint.output.segments) {
          if (segment.artifact_name === artifact.name && segment.artifact_id == null) segment.artifact_id = artifact.id;
        }
        valid.push({ artifact, checkpoint });
      } catch (error) {
        console.log(`::warning title=Ignoring invalid checkpoint artifact ${artifact.id}::${error.message || error}`);
      }
    }
    if (!valid.length) return null;
    valid.sort((left, right) => right.checkpoint.sequence - left.checkpoint.sequence || Date.parse(right.artifact.created_at) - Date.parse(left.artifact.created_at));
    const { artifact, checkpoint } = valid[0];
    console.log(`::notice title=Checkpoint restored::artifact_id=${artifact.id}; sequence=${checkpoint.sequence}; next_page=${checkpoint.slice?.next_page}; completed_ids=${checkpoint.completed_listing_ids.length}`);
    return checkpoint;
  }

  withPublishLock(operation) {
    const next = publicationMutex.then(operation, operation);
    publicationMutex = next.catch(() => {});
    return next;
  }
}

async function flushOnTermination() {
  try {
    if (currentPagePromise) await currentPagePromise;
    await publicationMutex;
    if (activeWorker?.state && activeWorker.state.status === "running") {
      activeWorker.state.sequence += 1;
      await activeWorker.artifactClient.publishCheckpoint(activeWorker.state, [], null);
    }
    process.exitCode = 0;
  } catch (error) {
    console.error(`Termination flush failed: ${error.message || error}`);
    process.exitCode = 1;
  }
}

function newCheckpoint(assignment) {
  return {
    version: CHECKPOINT_VERSION, run_key: assignment.run_key, source_site: "propertyfinder", base_search_url: process.env.BASE_SEARCH_URL || null,
    worker_id: assignment.worker_id, worker_count: assignment.worker_count, assigned_slice_ids: assignment.assigned_slice_ids,
    sequence: 0, status: "running", updated_at: new Date().toISOString(),
    slice: { id: null, min_price: null, max_price: null, search_url: null, listing_count_probe: null, current_page: 0, next_page: 1, completed: false },
    completed_slice_ids: [], completed_listing_ids: [], pending_listing_urls: [], failed_urls: [],
    output: { current_segment_path: null, segments: [] },
    publication: { artifact_name: null, artifact_id: null, artifact_digest: null, published_at: null },
  };
}

function validCheckpoint(value, assignment, artifact) {
  return value?.version === CHECKPOINT_VERSION && value.run_key === assignment.run_key && value.worker_id === assignment.worker_id &&
    Array.isArray(value.completed_listing_ids) && Array.isArray(value.output?.segments) && Number.isInteger(value.sequence) &&
    artifact.name === `${ARTIFACT_PREFIX}--${assignment.run_key}--w${assignment.worker_id}--s${value.slice?.id ?? "final"}--p${value.slice?.current_page ?? 0}--q${String(value.sequence).padStart(6, "0")}`;
}

async function validateCurrentSegment(checkpoint, artifactRoot) {
  const currentPath = checkpoint.output?.current_segment_path;
  if (!currentPath) return;
  const segment = checkpoint.output.segments.find((item) => item.path === currentPath);
  if (!segment?.sha256) throw new Error("Checkpoint current segment metadata is missing.");
  if (await fileSha256(join(artifactRoot, currentPath)) !== segment.sha256) throw new Error("Checkpoint current segment checksum mismatch.");
}
async function listArtifacts(prefix) {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const token = requiredEnv("GITHUB_TOKEN");
  const artifacts = [];
  for (let page = 1; page <= 5; page += 1) {
    const url = `https://api.github.com/repos/${repository}/actions/artifacts?per_page=100&page=${page}`;
    const response = await fetch(url, { headers: githubHeaders(token) });
    if (!response.ok) throw new Error(`Artifact listing failed: ${response.status}`);
    const batch = (await response.json()).artifacts || [];
    artifacts.push(...batch);
    if (batch.length < 100) break;
  }
  return artifacts.filter((artifact) => !artifact.expired && artifact.name.startsWith(prefix));
}

async function downloadAndExtractArtifact(id, target) {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const token = requiredEnv("GITHUB_TOKEN");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`, { headers: githubHeaders(token), redirect: "follow" });
  if (!response.ok) throw new Error(`Artifact download failed: ${response.status}`);
  await mkdir(target, { recursive: true });
  const zipPath = join(target, "artifact.zip");
  await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  await run("unzip", ["-oq", zipPath, "-d", target]);
  await rm(zipPath, { force: true });
}

function githubHeaders(token) {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
}

function validateAssignment(value) {
  if (!value || value.run_key == null || !Number.isInteger(value.worker_id) || !Array.isArray(value.assigned_slice_ids) || !Array.isArray(value.slices)) throw new Error("Invalid worker assignment.");
}

async function atomicJson(path, value) { await atomicText(path, `${JSON.stringify(value, null, 2)}\n`); }
async function atomicText(path, value) { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.tmp-${process.pid}-${Date.now()}`; await writeFile(temp, value, "utf8"); await rename(temp, path); }
async function fileSha256(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function relativeArtifactPath(path, root) { return path.slice(root.length + 1).replaceAll("\\", "/"); }
function stableRunKey(...values) { return `pf-${createHash("sha256").update(values.join("|")).digest("hex").slice(0, 16)}`; }
function uniqueNumbers(values) { return [...new Set(values)].sort((a, b) => a - b); }
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required.`); return value; }
function optionalNumberEnv(name) { return process.env[name] == null || process.env[name] === "" ? null : Number(process.env[name]); }
function integerEnv(name, fallback, min, max) { const value = Number(process.env[name] ?? fallback); return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.floor(value) : fallback)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function run(command, args) { return new Promise((resolve, reject) => { const child = spawn(command, args, { stdio: "ignore" }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))); }); }

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
