// cloud-runner/merge.js
// Deterministically merges downloaded worker page segments and an optional
// prior final output. Existing extension columns stay in their original order;
// anomaly columns are appended only.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import XLSX from "xlsx";
import { OUTPUT_FIELDS } from "../core/parser.js";
import { mergeFirstSeen } from "../core/dedupe.js";

const RELATIVE_MULTIPLIER = numberEnv("RELATIVE_PRICE_MULTIPLIER", 4);
const MIN_GROUP_SIZE = integerEnv("RELATIVE_MIN_GROUP_SIZE", 5);

async function main() {
  const inputDir = resolve(requiredEnv("SEGMENTS_DIR"));
  const outputDir = resolve(process.env.OUTPUT_DIR || "cloud-output");
  const priorFile = process.env.PRIOR_MERGED_FILE || null;
  const segmentFiles = (await findFiles(inputDir)).filter((path) => path.endsWith(".ndjson")).sort(naturalSegmentOrder);
  const prior = priorFile ? await readRows(priorFile) : [];
  const groups = [prior];
  for (const path of segmentFiles) groups.push(await readNdjson(path));
  const merged = mergeFirstSeen(groups);
  applyRelativeAnomaly(merged.listings);
  await mkdir(outputDir, { recursive: true });
  const csvPath = join(outputDir, "propertyfinder-scrape.csv");
  const xlsxPath = join(outputDir, "propertyfinder-scrape.xlsx");
  await writeFile(csvPath, toCsv(merged.listings), "utf8");
  writeXlsx(merged.listings, xlsxPath);
  await writeFile(join(outputDir, "merge-summary.json"), JSON.stringify({
    input_segments: segmentFiles.length, prior_rows: prior.length, output_rows: merged.listings.length, stats: merged.stats,
    fields: OUTPUT_FIELDS,
  }, null, 2));
  console.log(`::notice title=Merge complete::rows=${merged.listings.length}; csv=${csvPath}; xlsx=${xlsxPath}`);
}

function applyRelativeAnomaly(listings) {
  const groups = new Map();
  for (const listing of listings) {
    const ppsf = pricePerSqft(listing);
    listing.price_anomaly_relative = null;
    if (ppsf == null || !listing.community || !listing.property_type) continue;
    const key = `${listing.community}\u0000${listing.property_type}`;
    const group = groups.get(key) || [];
    group.push({ listing, ppsf });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < MIN_GROUP_SIZE) continue;
    const median = medianOf(group.map((entry) => entry.ppsf));
    for (const entry of group) {
      entry.listing.price_anomaly_relative = entry.ppsf > median * RELATIVE_MULTIPLIER || entry.ppsf < median / RELATIVE_MULTIPLIER;
    }
  }
}

function pricePerSqft(listing) {
  const price = numeric(listing.price_aed ?? listing.annual_rent_aed);
  const size = numeric(listing.size_sqft);
  return price != null && size != null && price > 0 && size > 0 ? price / size : null;
}

async function readRows(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".ndjson") return readNdjson(path);
  const workbook = XLSX.read(await readFile(path), { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
}

async function readNdjson(path) {
  const content = await readFile(path, "utf8");
  return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid NDJSON in ${path}, line ${index + 1}`); }
  });
}

function writeXlsx(listings, path) {
  const rows = listings.map(toOutputRow);
  const sheet = XLSX.utils.json_to_sheet(rows, { header: OUTPUT_FIELDS });
  sheet["!autofilter"] = { ref: sheet["!ref"] };
  sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  sheet["!cols"] = OUTPUT_FIELDS.map((field) => ({ wch: Math.min(60, Math.max(8, field.length + 2, ...rows.slice(0, 200).map((row) => String(row[field] ?? "").length + 2))) }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Listings");
  XLSX.writeFile(workbook, path);
}

function toCsv(listings) {
  const rows = [OUTPUT_FIELDS, ...listings.map((listing) => OUTPUT_FIELDS.map((field) => listing[field] ?? null))];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function csvCell(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toOutputRow(listing) {
  const row = {};
  for (const field of OUTPUT_FIELDS) row[field] = listing[field] ?? null;
  return row;
}

async function findFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await findFiles(path)); else output.push(path);
  }
  return output;
}

function naturalSegmentOrder(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredEnv(name) { if (!process.env[name]) throw new Error(`${name} is required.`); return process.env[name]; }
function numberEnv(name, fallback) { const value = Number(process.env[name] ?? fallback); return Number.isFinite(value) && value > 0 ? value : fallback; }
function integerEnv(name, fallback) { return Math.max(1, Math.floor(numberEnv(name, fallback))); }

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
