import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext, SourceTextModule } from "node:vm";

const pageUrl = "https://example.test/article";
const imageData = "data:image/png;base64,AQID";

async function savePreview({ source = "/preview.png", respond, injectedResult } = {}) {
  const requests = { page: [], extension: [] };
  const saved = {};
  const page = createContext({
    URL, AbortSignal, Blob,
    location: { href: pageUrl },
    document: {
      baseURI: pageUrl,
      querySelector: (selector) => ({
        'meta[property="og:image"]': { content: source },
        'meta[name="description"]': { content: "記事の   説明" },
      })[selector],
    },
    fetch: async (url, options) => {
      requests.page.push([url.href, options]);
      return respond ? respond() : new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      });
    },
    FileReader: class {
      async readAsDataURL(blob) {
        const data = Buffer.from(await blob.arrayBuffer()).toString("base64");
        this.result = `data:${blob.type};base64,${data}`;
        this.onload();
      }
    },
  });
  const extension = createContext({
    chrome: {
      tabs: { get: async () => ({ url: pageUrl }), onUpdated: { addListener() {}, removeListener() {} } },
      scripting: { executeScript: async ({ func, args, world }) => {
        assert.equal(world, "ISOLATED");
        const read = runInContext(`(${func})`, page);
        return [{ result: injectedResult ?? await read(...args) }];
      } },
      storage: { session: { set: async (value) => Object.assign(saved, value) } },
    },
    fetch: async (url) => {
      requests.extension.push(url);
      assert.match(url, /^data:image\//);
      return { blob: async () => ({}) };
    },
  });
  const names = ["page-preview.js", "tabs.js"];
  const modules = Object.fromEntries(await Promise.all(names.map(async (name) => {
    const content = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    return [name, new SourceTextModule(content, { context: extension })];
  })));
  modules["image.js"] = new SourceTextModule("export const resizeThumbnail = async () => 'thumbnail';", { context: extension });
  const preview = modules["page-preview.js"];
  await preview.link((name) => modules[name.slice(2)]);
  await preview.evaluate();
  await preview.namespace.savePagePreview({ id: 12, url: pageUrl }, 123);
  return { requests, saved: saved["page-preview:12"] };
}

test("page-supplied image URLs are fetched in the page only with its CORS rules", async () => {
  const { requests, saved } = await savePreview();
  const [[url, options]] = requests.page;
  assert.equal(url, "https://example.test/preview.png");
  assert.equal(options.mode, "cors");
  assert.equal(options.credentials, "omit");
  assert.equal(options.referrerPolicy, "no-referrer");
  assert.deepEqual(requests.extension, [imageData]);
  assert.deepEqual({ ...saved }, { url: pageUrl, requestedAt: 123, description: "記事の 説明", image: "thumbnail" });
});

test("CORS failures leave a text preview and cause no extension-origin requests", async () => {
  const { requests, saved } = await savePreview({
    source: "https://image-cdn.test/preview.png",
    respond: () => { throw new TypeError("CORS blocked"); },
  });
  assert.equal(requests.page.length, 1);
  assert.deepEqual(requests.extension, []);
  assert.equal(saved.description, "記事の 説明");
  assert.equal(saved.image, undefined);
});

test("a URL in the returned image field never becomes an extension-origin fetch", async () => {
  const { requests, saved } = await savePreview({
    injectedResult: { url: pageUrl, description: "概要", imageData: "http://localhost/private.png" },
  });
  assert.deepEqual(requests.extension, []);
  assert.equal(saved.description, "概要");
  assert.equal(saved.image, undefined);
});
