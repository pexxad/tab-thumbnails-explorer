import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

test("foreground thumbnail capture handles loading and overlapping tab switches", async () => {
  const event = () => {
    const handlers = [];
    return {
      addListener: (handler) => handlers.push(handler),
      fire: (...args) => {
        for (const handler of handlers) handler(...args);
      },
    };
  };
  const tab = {id: 1, windowId: 5, url: "https://fixture.example/a", status: "loading"};
  const other = {id: 2, windowId: 5, url: "https://fixture.example/b", status: "complete"};
  let activeTab = tab;
  let focused = true;
  let now = 1000;
  let captureCalls = 0;
  let gateFrame;
  let gateEncoding;
  let blank = false;
  const storage = {};
  const chrome = {
    windows: {get: async () => ({focused}), onFocusChanged: event()},
    tabs: {
      get: async id => ({...(id === tab.id ? tab : other), active: activeTab.id === id}),
      captureVisibleTab: async () => {
        captureCalls++;
        return gateFrame ?? "pixels";
      },
      onActivated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event(),
    },
    scripting: {executeScript: async () => []},
    runtime: {onConnect: event(), onMessage: event(), onInstalled: event(), onStartup: event()},
    storage: {session: {set: async data => Object.assign(storage, data)}},
  };
  function request(candidate = tab) {
    const message = {type: "capture-thumbnail", url: candidate.url};
    const sender = {frameId: 0, tab: candidate};
    return new Promise((resolve) => chrome.runtime.onMessage.fire(message, sender, resolve));
  }
  function switchTo(target) {
    activeTab = target;
    chrome.tabs.onActivated.fire({tabId: target.id});
  }
  class Canvas {
    getContext() {
      return {
        fillRect() {},
        drawImage() {},
        getImageData() {
          const data = new Uint8ClampedArray(64 * 36 * 4).fill(255);
          if (!blank) {
            for (let index = 0; index < data.length; index += 32) data.fill(0, index, index + 16);
          }
          return {data};
        },
      };
    }
    async convertToBlob() {
      return gateEncoding ?? {};
    }
  }
  class Reader {
    readAsDataURL() {
      this.result = "data:image/jpeg;base64,frame";
      this.onload();
    }
  }
  const context = createContext({
    chrome, performance: {now: () => now}, setTimeout, URL, console, OffscreenCanvas: Canvas, FileReader: Reader,
    fetch: async (source) => ({blob: async () => source}),
    createImageBitmap: async () => ({width: 1280, height: 720, close() {}}),
  });
  const files = ["background.js", "bulk-capture.js", "tabs.js", "image.js"];
  const modules = Object.fromEntries(await Promise.all(files.map(async (name) => {
    const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    return [name, new SourceTextModule(source, {context})];
  })));
  await modules["background.js"].link((specifier) => modules[specifier.slice(2)]);
  await modules["background.js"].evaluate();

  assert.equal((await request()).outcome, "saved", "ready observer does not wait for tabs.status complete");
  const first = storage["thumbnail:1"];
  assert.equal(first.url, tab.url);
  assert.equal(captureCalls, 1);
  assert.equal((await request()).retryAfter, 550);
  assert.equal(captureCalls, 1);

  now += 550;
  const raw = Promise.withResolvers();
  gateFrame = raw.promise;
  const capture = request();
  await setImmediate();
  assert.equal(captureCalls, 2);
  assert.equal((await request()).outcome, "limited", "deduplicates in-flight tab capture");
  switchTo(other);
  raw.resolve("other pixels");
  gateFrame = undefined;
  assert.equal((await capture).outcome, "inactive");
  assert.equal(storage["thumbnail:1"], first, "does not attribute a switched frame to the original tab");

  switchTo(tab);
  now += 550;
  const encoding = Promise.withResolvers();
  gateEncoding = encoding.promise;
  const verified = request();
  await setImmediate();
  assert.equal(captureCalls, 3);
  switchTo(other);
  encoding.resolve({});
  gateEncoding = undefined;
  assert.equal((await verified).outcome, "saved", "keeps verified pixels when user switches during encoding");
  const successor = storage["thumbnail:1"];
  assert.notEqual(successor, first);

  switchTo(tab);
  now += 550;
  const staleEncoding = Promise.withResolvers();
  gateEncoding = staleEncoding.promise;
  const stale = request();
  await setImmediate();
  chrome.tabs.onUpdated.fire(tab.id, {status: "loading"}, {...tab, active: true});
  staleEncoding.resolve({});
  gateEncoding = undefined;
  assert.equal((await stale).outcome, "waiting");
  assert.equal(storage["thumbnail:1"], successor, "same-URL reload invalidates the captured document");

  now += 550;
  blank = true;
  assert.equal((await request()).outcome, "blank");
  assert.equal(storage["thumbnail:1"], successor);
  blank = false;
  now += 550;
  focused = false;
  assert.equal((await request()).outcome, "inactive");
  assert.equal(captureCalls, 5);
});
