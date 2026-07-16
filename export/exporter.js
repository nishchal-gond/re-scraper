// export/exporter.js
// Runs in the popup (has window/Blob/chrome.downloads access).
// Expects the global `XLSX` to already be loaded via a <script> tag
// pointing at libs/xlsx.full.min.js (see popup.html) — MV3 popups can't
// import remote scripts, so it's loaded as a classic script, not an ES import.

import { LISTING_FIELDS } from "../models/listing-schema.js";

const DATE_FIELDS = new Set(["date_collected", "last_updated"]);
const NUMBER_FIELDS = new Set([
  "bedrooms", "bathrooms", "size_sqft", "price_aed",
  "BUA", "plot_size_sqft", "annual_rent_aed", "scrape_time_ms",
]);

function toRow(listing) {
  const row = {};
  for (const field of LISTING_FIELDS) {
    let v = listing[field];
    if (v === undefined) v = null;
    if (NUMBER_FIELDS.has(field) && v !== null) v = Number(v);
    row[field] = v;
  }
  return row;
}

export function exportToXLSX(listings, filename) {
  const rows = listings.map(toRow);
  const ws = XLSX.utils.json_to_sheet(rows, { header: LISTING_FIELDS });

  // Auto column widths (approximate — based on header + sample content length).
  const colWidths = LISTING_FIELDS.map((field) => {
    const headerLen = field.length;
    const maxContentLen = rows.reduce((max, r) => {
      const len = r[field] == null ? 0 : String(r[field]).length;
      return Math.max(max, len);
    }, 0);
    return { wch: Math.min(Math.max(headerLen, maxContentLen, 8) + 2, 60) };
  });
  ws["!cols"] = colWidths;

  // Freeze top row.
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  ws["!panes"] = [{ ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft", state: "frozen" }];

  // Optional filter across the header row.
  ws["!autofilter"] = { ref: ws["!ref"] };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Listings");

  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], { type: "application/octet-stream" });
  return { blob, filename: `${filename}.xlsx` };
}

export function exportToCSV(listings, filename) {
  const rows = listings.map(toRow);
  const ws = XLSX.utils.json_to_sheet(rows, { header: LISTING_FIELDS });
  const csv = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  return { blob, filename: `${filename}.csv` };
}

export function exportToJSON(listings, filename) {
  const json = JSON.stringify(listings, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  return { blob, filename: `${filename}.json` };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    // Revoke after a delay to make sure the download has started reading it.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}
