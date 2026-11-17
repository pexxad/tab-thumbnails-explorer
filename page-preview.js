import { resizeThumbnail } from "./image.js";
import { pagePreviewKey, webUrl } from "./tabs.js";

export function reloadAndWaitForPage(tabId) {
  return new Promise((resolve, reject) => {
    function stopWaiting() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    function onUpdated(id, change, tab) {
      if (id !== tabId || change.status !== "complete" || tab.discarded) return;
      stopWaiting();
      resolve(tab);
    }

    function onRemoved(id) {
      if (id !== tabId) return;
      stopWaiting();
      resolve();
    }

    const timeout = setTimeout(() => onRemoved(tabId), 30000);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.reload(tabId).catch((error) => {
      stopWaiting();
      reject(error);
    });
  });
}

export async function savePagePreview(tab, requestedAt) {
  const url = webUrl(tab);
  if (!url) return;

  // A later navigation, including another reload of the same URL, invalidates this preview.
  let navigated = false;
  function onUpdated(id, change) {
    if (id === tab.id && (change.url || change.status === "loading" || change.discarded)) navigated = true;
  }
  chrome.tabs.onUpdated.addListener(onUpdated);

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: readPagePreview, args: [url], world: "ISOLATED",
    });
    if (result?.url !== url || navigated) return;

    let image;
    if (typeof result.imageData === "string" && result.imageData.startsWith("data:image/")) {
      try {
        image = await resizeThumbnail(await (await fetch(result.imageData)).blob());
      } catch {
        // An invalid image can still have a useful text preview.
      }
    }
    if (!image && !result.description) return;
    const current = await chrome.tabs.get(tab.id);
    if (navigated || current.url !== url || current.pendingUrl || current.discarded) return;
    await chrome.storage.session.set({
      [pagePreviewKey(tab.id)]: { url, requestedAt, description: result.description, ...(image && { image }) },
    });
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

// Chrome runs this function in the tab's isolated world. Fetches here use the page's origin and CORS rules.
async function readPagePreview(expectedUrl) {
  const url = location.href;
  if (url !== expectedUrl) return;

  function metadata(selectors) {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.content?.trim();
      if (value) return value;
    }
    return "";
  }

  const description = metadata([
    'meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]',
  ]) || [...document.querySelectorAll("article p, main p")].find((p) => p.textContent.trim().length >= 30)?.textContent || "";

  const imageUrl = metadata([
    'meta[property="og:image:secure_url"]', 'meta[property="og:image"]',
    'meta[name="twitter:image"]', 'meta[property="twitter:image"]',
  ]);
  return {
    url,
    description: description.trim().replace(/\s+/g, " ").slice(0, 200),
    imageData: imageUrl ? await fetchImageData(imageUrl) : undefined,
  };

  async function fetchImageData(source) {
    const byteLimit = 4 * 1024 * 1024;
    try {
      const imageUrl = new URL(source, document.baseURI);
      if (!/^https?:$/.test(imageUrl.protocol) || imageUrl.username || imageUrl.password) return;

      const response = await fetch(imageUrl, {
        mode: "cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(5000),
      });
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > byteLimit ||
          !/^image\/(?:jpeg|png|webp|avif|gif)$/.test(type ?? "")) {
        await response.body?.cancel();
        return;
      }

      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > byteLimit) {
          await reader.cancel();
          return;
        }
        chunks.push(value);
      }
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(new Blob(chunks, { type }));
      });
    } catch {
      // Browser access restrictions and image download failures fall back to the description.
    }
  }
}
