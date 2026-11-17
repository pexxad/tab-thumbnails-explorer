export function webUrl(tab) {
  const url = tab.url || tab.pendingUrl;
  return /^https?:\/\//i.test(url ?? "") ? url : undefined;
}

export function thumbnailKey(tabId) {
  return `thumbnail:${tabId}`;
}

export function pagePreviewKey(tabId) {
  return `page-preview:${tabId}`;
}
