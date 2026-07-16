// popup/popup.js
import { exportToXLSX, exportToCSV, exportToJSON, downloadBlob } from "../export/exporter.js";

const $ = (id) => document.getElementById(id);

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (resp) => resolve(resp));
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------- Status rendering ----------
const STATUS_LABELS = {
  idle: "Idle", running: "● RUNNING", paused: "Paused",
  stopped: "Stopped", done: "Done", blocked: "Blocked",
};

function renderStatus(session, queueStats, listingCount) {
  const pill = $("statusPill");
  pill.textContent = STATUS_LABELS[session.status] || session.status;
  pill.className = `pill pill-${session.status}`;

  $("btnStart").classList.toggle("hidden", session.status === "running" || session.status === "paused");
  $("btnAutoSplit").classList.toggle("hidden", session.status === "running" || session.status === "paused");
  $("btnPause").classList.toggle("hidden", session.status !== "running");
  $("btnResume").classList.toggle(
    "hidden",
    !(session.status === "paused" || session.status === "blocked")
  );
  $("btnStop").classList.toggle(
    "hidden",
    !["running", "paused", "blocked"].includes(session.status)
  );

  $("blockedNotice").classList.toggle("hidden", session.status !== "blocked");

  const inBatch = Array.isArray(session.batchQueue) && session.batchQueue.length > 0;
  $("batchProgress").classList.toggle("hidden", !inBatch);
  if (inBatch) {
    $("batchProgress").textContent =
      `Slice ${session.batchIndex + 1}/${session.batchTotal}: ${session.originSearchUrl}`;
  }

  // Show the "will resume from page N" hint whenever the session is
  // stopped with prior progress — i.e. exactly the condition the
  // background's isResuming check in startScrape() uses. Kept in sync so
  // the popup never claims a behavior the engine doesn't actually do.
  const canResume = session.status === "stopped" && session.pagesProcessed > 0;
  $("resumeHint").classList.toggle("hidden", !canResume);
  if (canResume) $("resumeHintPage").textContent = String(session.currentPageNumber ?? "—");

  const total = queueStats.total || 0;
  const done = queueStats.done || 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $("progressBarFill").style.width = `${pct}%`;
  $("progressPct").textContent = `${pct}%`;

  $("statPage").textContent =
    session.currentPageNumber != null
      ? `${session.currentPageNumber}${session.totalPagesHint ? " / " + session.totalPagesHint : ""}`
      : "—";
  $("statScraped").textContent = String(done);
  $("statRemaining").textContent = String(queueStats.pending + queueStats.inProgress);
  $("statSuccess").textContent = String(session.successCount || 0);
  $("statErrors").textContent = String(session.failCount || 0);
  $("statRetries").textContent = String(session.retryCount || 0);
  $("listingCountText").textContent = String(listingCount);

  // Elapsed time since the scrape session first started. Kept running
  // through pause (so "how long has this actually taken, start to
  // finish" is honest) — it only stops advancing once idle/never started.
  if (session.startedAt) {
    $("elapsedText").textContent = `Elapsed: ${formatDuration(Date.now() - session.startedAt)}`;
  } else {
    $("elapsedText").textContent = "Elapsed: —";
  }

  // Simple ETA: (remaining / done-so-far-rate) — rough, not promised precise.
  if (session.startedAt && done > 0 && queueStats.pending > 0) {
    const elapsedMs = Date.now() - session.startedAt;
    const perItemMs = elapsedMs / done;
    const etaMs = perItemMs * queueStats.pending;
    $("etaText").textContent = `ETA: ${formatDuration(etaMs)}`;
  } else {
    $("etaText").textContent = "ETA: —";
  }
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

async function loadSettingsOnce() {
  const resp = await send({ type: "GET_SETTINGS" });
  if (resp?.ok) populateSettingsForm(resp.settings);
}

async function refreshStatus() {
  const resp = await send({ type: "GET_STATUS" });
  if (!resp?.ok) return;
  renderStatus(resp.session, resp.queueStats, resp.listingCount);
  // NOTE: deliberately NOT calling populateSettingsForm here. This function
  // runs on a 2s interval to keep progress numbers live — if it also
  // rewrote the Settings inputs every tick, it would overwrite whatever
  // the user was mid-typing before they hit Save (this is exactly what
  // caused "Max pages keeps snapping back to 50" / "End page keeps going
  // blank"). Settings are populated once on initial popup load and again
  // right after a successful save — never on this polling tick.
}

async function refreshLogs() {
  const resp = await send({ type: "GET_RECENT_LOGS", limit: 100 });
  if (!resp?.ok) return;
  const logList = $("logList");
  logList.innerHTML = resp.logs
    .map(
      (l) => {
        const timeStr = new Date(l.timestamp).toLocaleTimeString();
        let msg = escapeHtml(l.message);
        // Highlight URLs
        msg = msg.replace(/(https?:\/\/[^\s]+)/g, '<span class="log-url">$1</span>');
        return `<div class="log-line log-${l.level}"><span class="log-time">[${timeStr}]</span> <span class="log-msg">${msg}</span></div>`;
      }
    )
    .join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Controls ----------
$("btnStart").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  const resp = await send({ type: "START_SCRAPE", tabId: tab.id, url: tab.url });
  if (!resp?.ok) {
    $("unsupportedNotice").textContent = resp.error;
    $("unsupportedNotice").classList.remove("hidden");
    return;
  }
  $("unsupportedNotice").classList.add("hidden");
  refreshStatus();
});

$("btnAutoSplit").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  $("btnAutoSplit").disabled = true;
  $("btnAutoSplit").textContent = "⚡ Working out slices…";
  const resp = await send({ type: "AUTO_SPLIT_SCRAPE", tabId: tab.id, url: tab.url });
  $("btnAutoSplit").disabled = false;
  $("btnAutoSplit").textContent = "⚡ Auto-Split & Scrape";
  if (!resp?.ok) {
    $("unsupportedNotice").textContent = resp.error;
    $("unsupportedNotice").classList.remove("hidden");
    return;
  }
  $("unsupportedNotice").classList.add("hidden");
  refreshStatus();
});

$("btnToggleBatch").addEventListener("click", () => {
  $("batchPanel").classList.toggle("hidden");
});

$("btnStartBatch").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  const urls = $("batchUrls").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!urls.length) {
    alert("Paste at least one seed search URL, one per line.");
    return;
  }
  const resp = await send({ type: "START_BATCH_SCRAPE", tabId: tab.id, urls });
  if (!resp?.ok) {
    $("unsupportedNotice").textContent = resp.error;
    $("unsupportedNotice").classList.remove("hidden");
    return;
  }
  $("unsupportedNotice").classList.add("hidden");
  refreshStatus();
});

$("btnPause").addEventListener("click", async () => {
  await send({ type: "PAUSE_SCRAPE" });
  refreshStatus();
});
$("btnResume").addEventListener("click", async () => {
  await send({ type: "RESUME_SCRAPE" });
  refreshStatus();
});
$("btnStop").addEventListener("click", async () => {
  if (!confirm("Stop the current scrape? Collected data is kept.")) return;
  await send({ type: "STOP_SCRAPE" });
  refreshStatus();
});

// ---------- Settings ----------
function populateSettingsForm(settings) {
  $("setMaxPages").value = settings.maxPages;
  $("setEndPage").value = settings.endPage ?? "";
  $("setConcurrency").value = settings.concurrency;
  $("setFetchConcurrency").value = settings.fetchConcurrency ?? 30;
  $("setDelay").value = settings.delayBetweenRequestsMs;
  $("setRetries").value = settings.retryAttempts;
  $("setRawHtml").checked = settings.enableRawHtml;
  $("setAppend").checked = settings.appendExisting;
  $("exportFilename").value = settings.outputFilename;
  $("setAutoSplitThreshold").value = settings.autoSplitListingThreshold;
  $("setAutoSplitFloor").value = settings.autoSplitPriceFloor;
  $("setAutoSplitCeiling").value = settings.autoSplitPriceCeiling;
  $("setAutoSplitProbeLimit").value = settings.autoSplitProbeLimit;
}

$("btnSaveSettings").addEventListener("click", async () => {
  const settings = {
    maxPages: Number($("setMaxPages").value) || 50,
    endPage: $("setEndPage").value ? Number($("setEndPage").value) : null,
    concurrency: Number($("setConcurrency").value) || 8,
    fetchConcurrency: Number($("setFetchConcurrency").value) || 30,
    delayBetweenRequestsMs: Number.isFinite(Number($("setDelay").value)) ? Number($("setDelay").value) : 0,
    retryAttempts: Number($("setRetries").value) || 3,
    enableRawHtml: $("setRawHtml").checked,
    appendExisting: $("setAppend").checked,
    outputFilename: $("exportFilename").value || "real_estate_scrape",
  };
  const resp = await send({ type: "SET_SETTINGS", settings });
  if (resp?.ok) populateSettingsForm(resp.settings); // reflect any clamping (e.g. concurrency > 4)
  $("btnSaveSettings").textContent = "Saved ✓";
  setTimeout(() => ($("btnSaveSettings").textContent = "Save Settings"), 1200);
});

$("btnSaveAutoSplitSettings").addEventListener("click", async () => {
  const settings = {
    autoSplitListingThreshold: Number($("setAutoSplitThreshold").value) || 900,
    autoSplitPriceFloor: Number($("setAutoSplitFloor").value) || 0,
    autoSplitPriceCeiling: Number($("setAutoSplitCeiling").value) || 50000000,
    autoSplitProbeLimit: Number($("setAutoSplitProbeLimit").value) || 400,
  };
  const resp = await send({ type: "SET_SETTINGS", settings });
  if (resp?.ok) populateSettingsForm(resp.settings);
  $("btnSaveAutoSplitSettings").textContent = "Saved ✓";
  setTimeout(() => ($("btnSaveAutoSplitSettings").textContent = "Save Auto-Split Settings"), 1200);
});

// ---------- Export ----------
async function getListingsForExport() {
  const resp = await send({ type: "GET_ALL_LISTINGS" });
  return resp?.ok ? resp.listings : [];
}

$("btnExportXlsx").addEventListener("click", async () => {
  const listings = await getListingsForExport();
  if (!listings.length) return alert("No listings scraped yet.");
  const filename = $("exportFilename").value || "real_estate_scrape";
  const { blob, filename: fname } = exportToXLSX(listings, filename);
  downloadBlob(blob, fname);
});

$("btnExportCsv").addEventListener("click", async () => {
  const listings = await getListingsForExport();
  if (!listings.length) return alert("No listings scraped yet.");
  const filename = $("exportFilename").value || "real_estate_scrape";
  const { blob, filename: fname } = exportToCSV(listings, filename);
  downloadBlob(blob, fname);
});

$("btnExportJson").addEventListener("click", async () => {
  const listings = await getListingsForExport();
  if (!listings.length) return alert("No listings scraped yet.");
  const filename = $("exportFilename").value || "real_estate_scrape";
  const { blob, filename: fname } = exportToJSON(listings, filename);
  downloadBlob(blob, fname);
});

$("btnClearData").addEventListener("click", async () => {
  if (!confirm("Delete all scraped data? This can't be undone.")) return;
  await send({ type: "CLEAR_DATA" });
  refreshStatus();
});

// ---------- Live updates while popup is open ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS_UPDATE") {
    renderStatus(msg.session, msg.queueStats, msg.listingCount);
  }
});

refreshStatus();
loadSettingsOnce();
refreshLogs();
setInterval(refreshStatus, 2000);
setInterval(refreshLogs, 3000);
