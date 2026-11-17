import "./bulk-capture.js";
import { resizeThumbnail } from "./image.js";
import { pagePreviewKey, thumbnailKey, webUrl } from "./tabs.js";

// Chrome permits at most two captureVisibleTab calls per second across the extension.
const minimumCaptureInterval = 550;
const captures = new Map();
let lastCaptureAt = -Infinity;
let viewRevision = 0;

function captureCooldown() {
  return Math.max(0, Math.ceil(minimumCaptureInterval - (performance.now() - lastCaptureAt)));
}

function isCurrentPage(tab, url) {
  return !tab.discarded && !tab.pendingUrl && tab.url === url;
}

async function captureThumbnail(tabId, url) {
  if (captures.has(tabId)) return { outcome: "limited", retryAfter: minimumCaptureInterval };
  const view = viewRevision;
  const attempt = {};
  captures.set(tabId, attempt);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return { outcome: "inactive" };
    if (!isCurrentPage(tab, url)) return { outcome: "waiting" };
    const window = await chrome.windows.get(tab.windowId);
    if (!window.focused || window.incognito || view !== viewRevision) return { outcome: "inactive" };
    if (captures.get(tabId) !== attempt) return { outcome: "waiting" };

    const retryAfter = captureCooldown();
    if (retryAfter) return { outcome: "limited", retryAfter };
    lastCaptureAt = performance.now();
    const capturedAt = Date.now();
    const source = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
    const current = await chrome.tabs.get(tabId);
    if (view !== viewRevision || !current.active || current.windowId !== tab.windowId) return { outcome: "inactive" };
    if (captures.get(tabId) !== attempt || !isCurrentPage(current, url)) return { outcome: "waiting" };

    // These pixels are verified. Switching tabs while encoding must not throw them away.
    const image = await resizeThumbnail(await (await fetch(source)).blob(), { requireDetail: true });
    if (captures.get(tabId) !== attempt) return { outcome: "waiting" };
    if (!image) return { outcome: "blank", retryAfter: captureCooldown() };
    await chrome.storage.session.set({ [thumbnailKey(tabId)]: { url, image, capturedAt } });
    return { outcome: "saved" };
  } catch (error) {
    console.debug("Thumbnail capture skipped:", error);
    return { outcome: "waiting" };
  } finally {
    if (captures.get(tabId) === attempt) captures.delete(tabId);
  }
}

async function observeTab(tab) {
  const url = tab && webUrl(tab);
  if (!url || !tab.active || tab.discarded) return;
  const view = viewRevision;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, files: ["capture-observer.js"], injectImmediately: true,
    });
  } catch {
    // Some browser views (e.g. PDF) don't allow the observer. Fall back to Chrome's load event.
    if (tab.status !== "complete" || view !== viewRevision) return;
    const result = await captureThumbnail(tab.id, url);
    if (result.outcome === "limited") {
      setTimeout(() => {
        if (view === viewRevision) void captureThumbnail(tab.id, url);
      }, result.retryAfter);
    }
  }
}

async function observeFocusedWindow() {
  const window = await chrome.windows.getLastFocused();
  if (!window.focused) return;
  const [tab] = await chrome.tabs.query({ windowId: window.id, active: true });
  await observeTab(tab);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "capture-thumbnail" || sender.frameId !== 0 || !sender.tab ||
      typeof message.url !== "string" || !webUrl({ url: message.url })) return;
  void captureThumbnail(sender.tab.id, message.url).then(respond);
  return true;
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  viewRevision++;
  void chrome.tabs.get(tabId).then(observeTab).catch(console.debug);
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === "loading" || change.discarded) captures.delete(tabId);
  if (tab.active && (change.url || change.status === "complete")) void observeTab(tab);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  viewRevision++;
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void observeFocusedWindow().catch(console.debug);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  captures.delete(tabId);
  void chrome.storage.session.remove([thumbnailKey(tabId), pagePreviewKey(tabId)]);
});
chrome.tabs.onReplaced.addListener(async (addedId, removedId) => {
  captures.delete(removedId);
  const keys = [thumbnailKey, pagePreviewKey];
  const oldKeys = keys.map((key) => key(removedId));
  try {
    const stored = await chrome.storage.session.get(oldKeys);
    const tab = await chrome.tabs.get(addedId);
    // Some tab lifecycle operations replace the tab ID while retaining the page.
    if (tab.discarded) {
      const retained = {};
      for (const key of keys) {
        const value = stored[key(removedId)];
        if (value && value.url === tab.url) retained[key(addedId)] = value;
      }
      await chrome.storage.session.set(retained);
    }
    if (tab.active) await observeTab(tab);
  } catch (error) {
    console.debug("Replacement tab unavailable:", error);
  } finally {
    await chrome.storage.session.remove(oldKeys);
  }
});
chrome.runtime.onInstalled.addListener(() => void observeFocusedWindow().catch(console.debug));
chrome.runtime.onStartup.addListener(() => void observeFocusedWindow().catch(console.debug));
