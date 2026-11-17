import { reloadAndWaitForPage, savePagePreview } from "./page-preview.js";
import { pagePreviewKey, thumbnailKey, webUrl } from "./tabs.js";

const grid = document.querySelector("#grid");
const template = document.querySelector("#tab-card");
const search = document.querySelector("#search");
const count = document.querySelector("#count");
const empty = document.querySelector("#empty");
const errorMessage = document.querySelector("#error");
const bulkButton = document.querySelector("#bulk-capture");
const bulkStatus = document.querySelector("#bulk-status");

const cards = new Map();
const previews = new Map();
let overview;
let refreshTimer;
let refreshGeneration = 0;
let switching = false;
let bulkPort;

function showBulkStatus(message) {
  bulkStatus.textContent = message;
  bulkStatus.hidden = !message;
}

function toggleBulkCapture() {
  if (bulkPort) {
    bulkButton.disabled = true;
    showBulkStatus("撮影を中止しています…");
    try {
      bulkPort.postMessage({ type: "cancel" });
    } catch {
      // onDisconnect reports a lost connection and resets the button.
    }
    return;
  }

  const port = chrome.runtime.connect({ name: "bulk-thumbnail-capture" });
  bulkPort = port;
  bulkButton.textContent = "撮影を中止";
  showBulkStatus("一括撮影を準備しています…");

  function finish(message) {
    bulkPort = undefined;
    bulkButton.disabled = false;
    bulkButton.textContent = "未撮影を一括撮影";
    showBulkStatus(message);
  }

  port.onDisconnect.addListener(() => {
    if (bulkPort === port) finish("一括撮影の接続が切れました。");
  });
  port.onMessage.addListener(({ type, total, saved, skipped, failed, cancelled }) => {
    if (type === "progress") {
      if (!bulkButton.disabled) showBulkStatus(`撮影中 ${saved + skipped + failed} / ${total}件`);
      return;
    }
    if (type === "done") {
      const detail = [`${saved}件撮影`, skipped ? `${skipped}件対象外` : "", failed ? `${failed}件撮影不可` : ""];
      finish(total ? `${cancelled ? "中止しました" : "完了しました"}（${detail.filter(Boolean).join("、")}）` : "未撮影のタブはありません。");
    } else {
      finish(type === "busy" ? "別の一覧で一括撮影を実行中です。" : "一括撮影を開始できませんでした。");
    }
    port.disconnect();
  });
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}

function faviconUrl(url) {
  const icon = new URL(chrome.runtime.getURL("/_favicon/"));
  icon.searchParams.set("pageUrl", url);
  icon.searchParams.set("size", "32");
  return icon.href;
}

function makeCard(tabId) {
  const element = template.content.firstElementChild.cloneNode(true);
  const card = {
    element,
    open: element.querySelector(".open-tab"),
    reload: element.querySelector(".reload-tab"),
    close: element.querySelector(".close-tab"),
    title: element.querySelector(".tab-title"),
    domain: element.querySelector(".tab-domain"),
    status: element.querySelector(".tab-status"),
    previewText: element.querySelector(".preview-text"),
    thumbnail: element.querySelector(".thumbnail"),
    placeholder: element.querySelector(".placeholder"),
  };
  card.open.addEventListener("click", () => void switchTab(tabId));
  card.reload.addEventListener("click", () => void reloadTab(tabId, card));
  card.close.addEventListener("click", () => void closeTab(tabId));
  card.thumbnail.addEventListener("load", () => updateImageVisibility(card));
  card.thumbnail.addEventListener("error", () => updateImageVisibility(card));
  return card;
}

function updateImageVisibility(card) {
  const hasImage = !card.thumbnail.hidden && card.thumbnail.naturalWidth > 0;
  card.previewText.hidden = hasImage || !card.previewText.textContent;
  card.placeholder.hidden = hasImage || !card.previewText.hidden;
}

function updateThumbnail(tabId, card) {
  const screenshot = previews.get(thumbnailKey(tabId));
  const pagePreview = previews.get(pagePreviewKey(tabId));
  const hasScreenshot = screenshot?.url === card.url;
  const usePagePreview = pagePreview?.url === card.url &&
    (!hasScreenshot || pagePreview.requestedAt > (screenshot.capturedAt ?? 0));
  const source = usePagePreview ? pagePreview.image : hasScreenshot ? screenshot.image : undefined;
  card.previewText.textContent = usePagePreview ? pagePreview.description : "";
  card.thumbnail.classList.toggle("is-site-preview", Boolean(usePagePreview));
  card.thumbnail.title = usePagePreview ? "ページの共有画像" : "表示時のスクリーンショット";
  if (card.thumbnail.getAttribute("src") !== (source ?? null)) {
    if (source) card.thumbnail.src = source;
    else card.thumbnail.removeAttribute("src");
  }
  card.thumbnail.hidden = !source;
  updateImageVisibility(card);
}

function updateStatus(card) {
  const loading = card.statusValue === "loading" || card.reloadPhase === "page";
  const preparing = card.reloadPhase === "preview";
  const label = loading ? "読み込み中" : preparing ? "プレビュー取得中" : card.discarded ? "休止中" : "";
  card.status.textContent = label;
  card.status.hidden = !label;
  card.status.classList.toggle("is-loading", loading || preparing);
  card.reload.disabled = loading || preparing;
}

function updateCard(card, tab, url) {
  const domain = new URL(url).host;
  const title = tab.title || domain;
  if (card.url !== url) card.placeholder.src = faviconUrl(url);
  card.url = url;
  card.tabTitle = title;
  card.title.textContent = title;
  card.domain.textContent = domain;
  card.open.title = url;
  card.open.setAttribute("aria-label", `${title} に切り替え`);
  card.reload.setAttribute("aria-label", `${title} を再読み込み`);
  card.close.setAttribute("aria-label", `${title} を閉じる`);
  card.statusValue = tab.status;
  card.discarded = tab.discarded;
  updateStatus(card);
  updateThumbnail(tab.id, card);
}

function applySearch() {
  const query = search.value.trim().toLowerCase();
  let matches = 0;
  for (const card of cards.values()) {
    const match = card.tabTitle.toLowerCase().includes(query) || card.url.toLowerCase().includes(query);
    card.element.hidden = !match;
    if (match) matches++;
  }
  count.value = query ? `${matches} / ${cards.size}` : `${cards.size}`;
  empty.hidden = matches > 0;
  empty.textContent = query ? "一致するタブがありません。" : "開いているWebタブはありません。";
}

async function refresh() {
  const generation = ++refreshGeneration;
  try {
    const tabs = await chrome.tabs.query({ windowId: overview.windowId });
    if (generation !== refreshGeneration) return;
    const nextIds = new Set();
    let nextElement = grid.firstElementChild;
    for (const tab of tabs.sort((left, right) => left.index - right.index)) {
      const url = webUrl(tab);
      if (!url) continue;
      nextIds.add(tab.id);
      const card = cards.get(tab.id) ?? makeCard(tab.id);
      updateCard(card, tab, url);
      cards.set(tab.id, card);
      if (card.element !== nextElement) grid.insertBefore(card.element, nextElement);
      nextElement = card.element.nextElementSibling;
    }
    for (const [tabId, card] of cards) {
      if (nextIds.has(tabId)) continue;
      card.element.remove();
      cards.delete(tabId);
    }
    applySearch();
  } catch (error) {
    if (generation === refreshGeneration) showError("タブ一覧を取得できませんでした。");
    console.error(error);
  }
}

function scheduleRefresh() {
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, 40);
}

async function switchTab(tabId) {
  if (switching) return;
  switching = true;
  showError("");
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== overview.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.remove(overview.id);
  } catch (error) {
    showError("タブを切り替えられませんでした。");
    console.error(error);
    scheduleRefresh();
  } finally {
    switching = false;
  }
}

async function reloadTab(tabId, card) {
  showError("");
  const requestedAt = Date.now();
  card.reloadPhase = "page";
  updateStatus(card);
  try {
    const tab = await reloadAndWaitForPage(tabId);
    if (!tab) return;
    card.statusValue = tab.status;
    card.reloadPhase = "preview";
    updateStatus(card);
    await savePagePreview(tab, requestedAt).catch((error) => console.debug("Page preview unavailable:", error));
  } catch (error) {
    showError("タブを再読み込みできませんでした。");
    console.error(error);
  } finally {
    card.reloadPhase = undefined;
    updateStatus(card);
    scheduleRefresh();
  }
}

async function closeTab(tabId) {
  showError("");
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    showError("タブを閉じられませんでした。");
    console.error(error);
  }
  scheduleRefresh();
}

async function init() {
  overview = await chrome.tabs.getCurrent();
  if (!overview) return;
  bulkButton.addEventListener("click", toggleBulkCapture);
  search.addEventListener("input", applySearch);
  for (const event of [
    chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onAttached,
    chrome.tabs.onDetached, chrome.tabs.onReplaced, chrome.tabs.onUpdated,
  ]) {
    event.addListener(scheduleRefresh);
  }

  // An event can update a thumbnail before the initial storage read finishes.
  let changedDuringRead = new Set();
  chrome.storage.session.onChanged.addListener((changes) => {
    for (const [key, change] of Object.entries(changes)) {
      const match = /^(?:thumbnail|page-preview):(\d+)$/.exec(key);
      if (!match) continue;
      changedDuringRead?.add(key);
      if (change.newValue) previews.set(key, change.newValue);
      else previews.delete(key);
      const tabId = Number(match[1]);
      const card = cards.get(tabId);
      if (card) updateThumbnail(tabId, card);
    }
  });
  void refresh();
  try {
    const storedPreviews = await chrome.storage.session.get();
    for (const [key, preview] of Object.entries(storedPreviews)) {
      if (!changedDuringRead.has(key)) previews.set(key, preview);
    }
    for (const [tabId, card] of cards) updateThumbnail(tabId, card);
  } finally {
    changedDuringRead = undefined;
  }
}

void init().catch(console.error);
