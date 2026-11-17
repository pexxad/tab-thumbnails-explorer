import { resizeThumbnail } from "./image.js";
import { thumbnailKey, webUrl } from "./tabs.js";

const screenshotTimeout = 8000;
let running = false;

function isReady(tab, url, windowId) {
  return tab.windowId === windowId && tab.url === url && tab.status === "complete" &&
    !tab.discarded && !tab.frozen && !tab.pendingUrl;
}

function captureFrame(target, signal) {
  signal.throwIfAborted();
  let timeout;
  let cancel;
  return new Promise((resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    timeout = setTimeout(() => reject(new Error("Screenshot timed out")), screenshotTimeout);
    chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "jpeg", quality: 65, fromSurface: true,
    }).then(resolve, reject);
  }).finally(() => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  });
}

async function captureTab(tab, url, signal) {
  const { id: tabId, windowId } = tab;
  const target = { tabId };
  let invalidated = false;
  function onUpdated(id, change) {
    if (id === tabId && (change.url || change.status === "loading" || change.discarded)) invalidated = true;
  }

  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    const current = await chrome.tabs.get(tabId);
    if (signal.aborted || invalidated || !isReady(current, url, windowId)) return "skipped";
    let data;
    let capturedAt;
    await chrome.debugger.attach(target, "1.3");
    try {
      if (signal.aborted || invalidated) return "skipped";
      capturedAt = Date.now();
      ({ data } = await captureFrame(target, signal));
    } finally {
      // Detach before resizing or writing so Chrome can release the debugging session promptly.
      await chrome.debugger.detach(target).catch((error) => console.debug("Debugger detached or unavailable:", error));
    }

    if (signal.aborted || invalidated) return "skipped";
    if (!data) return "failed";
    const image = await resizeThumbnail(await (await fetch(`data:image/jpeg;base64,${data}`)).blob(), { requireDetail: true });
    if (!image) return "failed";
    const key = thumbnailKey(tabId);
    const { [key]: existing } = await chrome.storage.session.get(key);
    const latest = await chrome.tabs.get(tabId);
    if (signal.aborted || invalidated || !isReady(latest, url, windowId) ||
        (existing?.url === url && existing.capturedAt >= capturedAt)) return "skipped";
    await chrome.storage.session.set({ [key]: { url, image, capturedAt } });
    return "saved";
  } catch (error) {
    if (signal.aborted || invalidated) return "skipped";
    console.debug("Background thumbnail unavailable:", error);
    return "failed";
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

async function captureMissing(windowId, signal, report) {
  const [windowTabs, debugTargets] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.debugger.getTargets(),
  ]);
  const tabs = windowTabs.filter((tab) => webUrl(tab));
  const alreadyDebugged = new Set(debugTargets.filter((target) => target.attached).map((target) => target.tabId));
  const existing = await chrome.storage.session.get(tabs.map((tab) => thumbnailKey(tab.id)));
  const missing = tabs.filter((tab) => {
    const saved = existing[thumbnailKey(tab.id)];
    return !saved?.image || saved.url !== webUrl(tab);
  });
  const progress = { total: missing.length, saved: 0, skipped: 0, failed: 0 };
  report({ type: "progress", ...progress });
  for (const tab of missing) {
    if (signal.aborted) break;
    const outcome = alreadyDebugged.has(tab.id) ? "skipped" : await captureTab(tab, webUrl(tab), signal);
    progress[outcome]++;
    report({ type: "progress", ...progress });
  }
  return { type: "done", ...progress, cancelled: signal.aborted };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bulk-thumbnail-capture") return;
  const sender = port.sender;
  const fromOverview = sender?.url === chrome.runtime.getURL("new-tab.html") ||
    sender?.origin === chrome.runtime.getURL("").slice(0, -1);
  if (!fromOverview || sender.frameId !== 0 || !sender.tab || sender.tab.incognito) {
    port.disconnect();
    return;
  }
  if (running) {
    port.postMessage({ type: "busy" });
    return;
  }

  running = true;
  const controller = new AbortController();
  let connected = true;
  function report(message) {
    if (!connected) return;
    try {
      port.postMessage(message);
    } catch {
      connected = false;
      controller.abort();
    }
  }
  function cancelFromChrome(_, reason) {
    if (reason === "canceled_by_user") controller.abort();
  }

  port.onDisconnect.addListener(() => {
    connected = false;
    controller.abort();
  });
  port.onMessage.addListener((message) => {
    if (message?.type === "cancel") controller.abort();
  });
  chrome.debugger.onDetach.addListener(cancelFromChrome);
  void captureMissing(sender.tab.windowId, controller.signal, report).then(report, (error) => {
    console.debug("Bulk thumbnail capture failed:", error);
    report({ type: "error" });
  }).finally(() => {
    chrome.debugger.onDetach.removeListener(cancelFromChrome);
    running = false;
  });
});
