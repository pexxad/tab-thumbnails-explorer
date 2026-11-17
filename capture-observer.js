(() => {
  if (globalThis.tabThumbnailObserver) {
    globalThis.tabThumbnailObserver();
    return;
  }

  let stopWatching;
  let requestCheck;
  let watchingUrl;
  let savedUrl;
  const refinementInterval = 650;

  function startWatching() {
    const url = location.href;
    if (document.visibilityState !== "visible") return;
    if (watchingUrl === url) {
      requestCheck();
      return;
    }
    stopWatching?.();
    if (savedUrl === url) return;
    watchingUrl = url;

    const listeners = new AbortController();
    const mutations = new MutationObserver(queueCheck);
    let paints;
    let frame;
    let retry;
    let checking = false;
    let changed = false;
    let rejectedContent;
    let resourceRevision = 0;
    let refinements = 0;

    function scheduleCheck(delay) {
      retry = setTimeout(() => {
        retry = undefined;
        queueCheck();
      }, delay);
    }

    function advanceRefinement() {
      refinements++;
      if (refinements === 2) stopWatching();
      else scheduleCheck(refinementInterval);
    }

    function queueCheck() {
      if (listeners.signal.aborted) return;
      changed = true;
      if (frame !== undefined || retry !== undefined || checking) return;
      // Let Chrome paint a frame after the DOM change before requesting its pixels.
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(check); });
    }

    async function check() {
      frame = undefined;
      changed = false;
      if (document.visibilityState !== "visible") return;
      if (location.href !== url) {
        startWatching();
        return;
      }
      const refining = savedUrl === url;
      // Reserve the last sample for rendering after the browser has finished loading.
      if (refining && refinements === 1 && document.readyState !== "complete") return;
      const content = visibleContentKey();
      if (!content) {
        if (refining && refinements === 0) advanceRefinement();
        return;
      }
      const candidate = `${resourceRevision}:${content}`;
      if (!refining && rejectedContent?.candidate === candidate && rejectedContent.retried) return;

      checking = true;
      let result;
      try {
        result = await chrome.runtime.sendMessage({ type: "capture-thumbnail", url });
      } catch {
        // An extension reload invalidates the old content-script context.
        if (!listeners.signal.aborted) stopWatching();
        return;
      } finally {
        checking = false;
      }
      if (listeners.signal.aborted) return;
      if (!result || result.outcome === "inactive") {
        stopWatching();
        return;
      }
      if (result.outcome === "limited") {
        scheduleCheck(result.retryAfter);
        return;
      }
      if (refining && (result.outcome === "saved" || result.outcome === "blank")) {
        advanceRefinement();
        return;
      }
      if (result.outcome === "saved") {
        savedUrl = url;
        scheduleCheck(refinementInterval);
        return;
      }
      // Retry a rejected frame once without a new event. Further attempts need a page change.
      const retryBlank = result.outcome === "blank" && rejectedContent?.candidate !== candidate;
      if (result.outcome === "blank") rejectedContent = { candidate, retried: !retryBlank };
      if (retryBlank || changed) scheduleCheck(result.retryAfter ?? 0);
    }

    stopWatching = () => {
      listeners.abort();
      mutations.disconnect();
      paints?.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(retry);
      stopWatching = undefined;
      requestCheck = undefined;
      watchingUrl = undefined;
    };
    requestCheck = queueCheck;
    mutations.observe(document, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["aria-busy", "hidden", "class", "style"],
    });
    const { signal } = listeners;
    function resourceRendered() {
      resourceRevision++;
      queueCheck();
    }
    document.addEventListener("load", resourceRendered, { capture: true, signal });
    document.addEventListener("loadeddata", resourceRendered, { capture: true, signal });
    document.addEventListener("readystatechange", queueCheck, { signal });
    if (PerformanceObserver.supportedEntryTypes.includes("paint")) {
      paints = new PerformanceObserver(queueCheck);
      paints.observe({ type: "paint", buffered: true });
    }
    queueCheck();
  }

  function visibleContentKey() {
    const body = document.body;
    if (!body) return document.readyState !== "loading" && document.documentElement?.localName;
    const main = document.querySelector('main, [role="main"], article') ?? body;
    if ([document.documentElement, body, main].some((element) => element.getAttribute("aria-busy") === "true")) return false;

    const text = main.innerText?.trim() ?? "";
    if (/^(?:loading(?:\s+please wait)?|please wait|読み込み中|ロード中|お待ちください)[\s.!。…・]*$/i.test(text)) return false;
    if (text && (main !== body || document.readyState !== "loading" || body.querySelector("h1, p"))) {
      return `${text.length}:${text.slice(0, 160)}:${text.slice(-80)}`;
    }
    const media = Array.from(main.querySelectorAll("img, video, svg, canvas, iframe, object, embed")).find((element) => {
      if (element.localName === "img" && (!element.complete || !element.naturalWidth)) return false;
      if (element.localName === "video" && element.readyState < 2) return false;
      const { width, height } = element.getBoundingClientRect();
      return width > 0 && height > 0;
    });
    if (media) return `${media.localName}:${media.currentSrc ?? ""}`;
  }

  function leavePage() {
    savedUrl = undefined;
    stopWatching?.();
  }

  globalThis.tabThumbnailObserver = startWatching;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") startWatching();
    else leavePage();
  });
  window.addEventListener("pageshow", startWatching);
  window.addEventListener("pagehide", leavePage);
  window.addEventListener("popstate", startWatching);
  window.addEventListener("hashchange", startWatching);
  startWatching();
})();
