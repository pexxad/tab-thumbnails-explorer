import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createContext, SourceTextModule } from "node:vm";

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    fire: (...args) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

async function setup(tabs, { snapshot, timeoutOnNextTick = false } = {}) {
  const history = [];
  const storage = { "thumbnail:2": { url: "https://example.test/2", image: "prior" } };
  const attached = new Set();
  const chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://fixture/${path}`,
      onConnect: event(),
    },
    tabs: {
      query: async ({ windowId }) => tabs.filter((tab) => tab.windowId === windowId),
      get: async (id) => ({ ...tabs.find((tab) => tab.id === id) }),
      onUpdated: event(),
    },
    storage: { session: {
      get: async (keys) => Object.fromEntries([keys].flat().map((key) => [key, storage[key]])),
      set: async (changed) => Object.assign(storage, changed),
    } },
    debugger: {
      onDetach: event(),
      getTargets: async () => [{ tabId: 5, attached: true }],
      attach: async ({ tabId }, version) => {
        assert.equal(version, "1.3");
        assert.equal(attached.size, 0);
        attached.add(tabId);
        history.push(["attach", tabId]);
      },
      sendCommand: async ({ tabId }, command, options) => {
        assert.equal(command, "Page.captureScreenshot");
        assert.equal(options.fromSurface, true);
        assert.ok(attached.has(tabId));
        return snapshot ? snapshot(tabId, chrome) : { data: "test-jpeg" };
      },
      detach: async ({ tabId }) => {
        assert.ok(attached.delete(tabId));
        history.push(["detach", tabId]);
        chrome.debugger.onDetach.fire({ tabId }, "target_closed");
      },
    },
  };
  const context = createContext({
    chrome, AbortController, clearTimeout,
    setTimeout: (fn, ms) => setTimeout(fn, timeoutOnNextTick ? 0 : ms),
    fetch: async (source) => ({ blob: async () => source }),
    console: { debug() {} },
  });
  const names = ["bulk-capture.js", "tabs.js"];
  const modules = Object.fromEntries(await Promise.all(names.map(async (name) => {
    const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
    return [name, new SourceTextModule(source, { context })];
  })));
  modules["image.js"] = new SourceTextModule(`export async function resizeThumbnail(blob, { requireDetail }) {
    if (!requireDetail) throw new Error("Bulk captures must reject blank frames");
    return blob.endsWith("blank") ? undefined : "thumbnail";
  }`, { context });
  await modules["bulk-capture.js"].link((name) => modules[name.slice(2)]);
  await modules["bulk-capture.js"].evaluate();

  function connect(origin = "chrome-extension://fixture") {
    const done = Promise.withResolvers();
    const port = {
      name: "bulk-thumbnail-capture",
      sender: { origin, frameId: 0, tab: { windowId: 42 } },
      onDisconnect: event(),
      onMessage: event(),
      disconnect: () => done.resolve({ type: "disconnected" }),
      postMessage: (message) => {
        if (message.type !== "progress") done.resolve(message);
      },
    };
    chrome.runtime.onConnect.fire(port);
    return { port, done: done.promise };
  }

  function dismissChromeNotice(tabId) {
    attached.delete(tabId);
    chrome.debugger.onDetach.fire({ tabId }, "canceled_by_user");
  }

  return { history, storage, attached, connect, dismissChromeNotice };
}

function tab(id, options = {}) {
  return { id, windowId: 42, status: "complete", url: `https://example.test/${id}`, ...options };
}

test("bulk capture uses one debug session at a time and skips tabs without an eligible page", async () => {
  const state = await setup([
    tab(1), tab(2), tab(3, { discarded: true }), tab(4, { status: "loading" }), tab(5),
    tab(6, { windowId: 77 }), tab(7, { url: "chrome://settings/" }), tab(8), tab(9),
  ], { snapshot(id) {
    if (id === 8) throw new Error("Capture rejected by Chrome");
    return { data: id === 9 ? "blank" : "test-jpeg" };
  } });
  assert.deepEqual(state.history, []);
  assert.equal((await state.connect("https://webpage.test").done).type, "disconnected");
  const result = await state.connect().done;
  assert.deepEqual(state.history, [["attach", 1], ["detach", 1], ["attach", 8], ["detach", 8], ["attach", 9], ["detach", 9]]);
  assert.deepEqual({ ...result }, { type: "done", total: 6, saved: 1, skipped: 3, failed: 2, cancelled: false });
  assert.equal(state.storage["thumbnail:1"].image, "thumbnail");
  assert.equal(state.storage["thumbnail:9"], undefined);
  assert.equal(state.attached.size, 0);
});

test("cancelling a stalled screenshot releases its debug session and stops the batch", async () => {
  const state = await setup([tab(1), tab(8)], { snapshot: () => new Promise(() => {}) });
  const { port, done } = state.connect();
  await setImmediate();
  assert.deepEqual(state.history, [["attach", 1]]);
  assert.equal((await state.connect().done).type, "busy");
  port.onMessage.fire({ type: "cancel" });
  assert.equal((await done).cancelled, true);
  assert.deepEqual(state.history, [["attach", 1], ["detach", 1]]);
  assert.equal(state.attached.size, 0);
});

test("timeout and same-URL navigation release attachments without saving stale pixels", async () => {
  const state = await setup([tab(1), tab(8)], {
    timeoutOnNextTick: true,
    snapshot(id, chrome) {
      if (id === 1) return new Promise(() => {});
      chrome.tabs.onUpdated.fire(id, { status: "loading" });
      return { data: "navigated-jpeg" };
    },
  });
  const result = await state.connect().done;
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.saved, 0);
  assert.equal(state.attached.size, 0);
});

test("closing the overview or dismissing the Chrome notification stops the remaining batch", async () => {
  for (const source of ["overview", "Chrome notification"]) {
    const state = await setup([tab(1), tab(8)], { snapshot: () => new Promise(() => {}) });
    const { port, done } = state.connect();
    await setImmediate();
    if (source === "Chrome notification") {
      state.dismissChromeNotice(1);
      assert.equal((await done).cancelled, true);
    } else {
      port.onDisconnect.fire();
      await setImmediate();
    }
    assert.equal(state.attached.size, 0);
    assert.equal(state.history.some(([action, id]) => action === "attach" && id === 8), false);
  }
});
