// Deterministic multi-instance harness for app/index.html.
//
// Runs the app's main <script> block in one `vm` context per simulated
// instance (a tab, or the installed window). Every instance gets its own
// DOM stubs, timers and auth, while the things a real browser shares
// between same-origin instances are shared here too: one localStorage
// (with `storage` events delivered to the other instances), one Web Locks
// manager, one virtual clock and one in-memory Firestore behind fetch.
//
// Nothing is real time. `harness.advance(ms)` moves the clock and runs due
// timers of every instance that is not frozen; `instance.freeze()` models
// a tab Chrome has suspended (no timers, no events until `thaw()`).

"use strict";

process.env.TZ = process.env.TZ || "America/Mexico_City";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodeCrypto = require("node:crypto");

const APP_PATH = path.join(__dirname, "..", "app", "index.html");

function extractMainScript() {
  const html = fs.readFileSync(APP_PATH, "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("app/index.html: main <script> block not found");
  return match[1];
}

const MAIN_SCRIPT = extractMainScript();

const settle = () => new Promise((resolve) => setImmediate(resolve));
async function drainMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) await settle();
}

// ---- Shared pieces ----

class Clock {
  constructor(startIso = "2026-09-05T18:00:00.000Z") {
    this.nowMs = new Date(startIso).getTime();
  }
  now() { return this.nowMs; }
  iso() { return new Date(this.nowMs).toISOString(); }
}

class SharedStorage {
  constructor() { this.map = new Map(); this.instances = new Set(); this.writes = []; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  json(key) { const raw = this.getItem(key); return raw == null ? null : JSON.parse(raw); }
  writersOf(key) { return [...new Set(this.writes.filter((w) => w.key === key).map((w) => w.by))]; }
  // Writes come from one instance; the others get a queued `storage` event,
  // as browsers deliver it (asynchronously, never to the writer itself).
  write(from, key, value) {
    const oldValue = this.getItem(key);
    this.writes.push({ by: from.name, key, at: from.harness.clock.now() });
    if (value === null) this.map.delete(key); else this.map.set(key, String(value));
    if (oldValue === value) return;
    for (const inst of this.instances) {
      if (inst !== from && !inst.closed) inst.queueEvent("storage", { key, oldValue, newValue: value });
    }
  }
  forInstance(inst) {
    const storage = this;
    return {
      getItem: (key) => storage.getItem(String(key)),
      setItem: (key, value) => storage.write(inst, String(key), String(value)),
      removeItem: (key) => storage.write(inst, String(key), null),
      clear: () => { for (const key of [...storage.map.keys()]) storage.write(inst, key, null); },
      key: (i) => [...storage.map.keys()][i] ?? null,
      get length() { return storage.map.size; }
    };
  }
}

// Web Locks: exclusive, FIFO, with `steal`. A stolen holder's request
// promise rejects with AbortError, exactly like Chrome.
class SharedLocks {
  constructor() { this.held = new Map(); this.queues = new Map(); this.log = []; }
  request(inst, name, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    options = options || {};
    return new Promise((resolve, reject) => {
      const req = { inst, name, callback, resolve, reject, steal: Boolean(options.steal) };
      const holder = this.held.get(name);
      if (req.steal) {
        if (holder) {
          this.held.delete(name);
          this.log.push({ at: "steal", by: inst.name, from: holder.inst.name });
          const error = new Error("Lock broken by another request with the 'steal' option.");
          error.name = "AbortError";
          holder.reject(error);
        }
        this.grant(req);
      } else if (!holder) {
        this.grant(req);
      } else {
        if (!this.queues.has(name)) this.queues.set(name, []);
        this.queues.get(name).push(req);
      }
    });
  }
  grant(req) {
    this.held.set(req.name, req);
    this.log.push({ at: "grant", to: req.inst.name });
    Promise.resolve().then(() => req.callback({ name: req.name, mode: "exclusive" })).then(
      (value) => { if (this.held.get(req.name) === req) { this.held.delete(req.name); req.resolve(value); this.next(req.name); } },
      (error) => { if (this.held.get(req.name) === req) { this.held.delete(req.name); req.reject(error); this.next(req.name); } }
    );
  }
  next(name) {
    const queue = this.queues.get(name);
    if (queue && queue.length) this.grant(queue.shift());
  }
  // A closing page releases what it holds and abandons what it queued.
  releaseAll(inst) {
    for (const [name, queue] of this.queues) this.queues.set(name, queue.filter((req) => req.inst !== inst));
    for (const [name, holder] of [...this.held]) {
      if (holder.inst === inst) { this.held.delete(name); this.next(name); }
    }
  }
  holder(name) { const h = this.held.get(name); return h ? h.inst.name : null; }
}

// In-memory Firestore behind the four REST calls the app makes.
class FakeFirestore {
  constructor(clock) {
    this.clock = clock;
    this.docs = new Map();      // full doc name -> { fields }
    this.holdWrites = false;    // when true, :commit calls wait for release()
    this.heldWrites = [];
    this.requests = [];
  }
  release() { const held = this.heldWrites; this.heldWrites = []; for (const go of held) go(); }
  docsUnder(uid) {
    const prefix = `users/${uid}/focus_sessions/`;
    return [...this.docs.entries()].filter(([name]) => name.includes(prefix));
  }
  liveSessions(uid) {
    return this.docsUnder(uid)
      .filter(([, doc]) => !("timestampValue" in (doc.fields.deletedAt || {})))
      .map(([name]) => name.split("/").pop());
  }
  async fetch(url, options = {}) {
    const method = options.method || "GET";
    this.requests.push({ url, method });
    if (method === "HEAD" || (method === "GET" && !url.includes("firestore.googleapis.com"))) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    }
    const body = options.body ? JSON.parse(options.body) : {};
    if (url.includes(":commit")) {
      if (this.holdWrites) await new Promise((go) => this.heldWrites.push(go));
      return this.commit(body);
    }
    if (url.includes(":runAggregationQuery")) {
      const uid = url.match(/users\/([^/:]+):/)[1];
      const n = this.docsUnder(uid).length;
      return { ok: true, status: 200, json: async () => [{ result: { aggregateFields: { n: { integerValue: String(n) } } } }] };
    }
    if (url.includes(":runQuery")) {
      const uid = url.match(/users\/([^/:]+):/)[1];
      return { ok: true, status: 200, json: async () => this.runQuery(uid, body.structuredQuery) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "unknown endpoint " + url }) };
  }
  commit(body) {
    const write = body.writes[0];
    const name = write.update.name.replace(/^projects\/[^/]+\/databases\/\(default\)\/documents\//, "");
    const existing = this.docs.get(name);
    if (write.currentDocument && write.currentDocument.exists === false) {
      if (existing) return { ok: false, status: 409, json: async () => ({ error: { status: "ALREADY_EXISTS" } }) };
      const fields = { ...write.update.fields };
      for (const transform of write.updateTransforms || []) {
        if (transform.setToServerValue === "REQUEST_TIME") fields[transform.fieldPath] = { timestampValue: this.clock.iso() };
      }
      this.docs.set(name, { fields });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (write.updateMask) {
      if (!existing) return { ok: false, status: 404, json: async () => ({ error: { status: "NOT_FOUND" } }) };
      for (const fieldPath of write.updateMask.fieldPaths) existing.fields[fieldPath] = write.update.fields[fieldPath];
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: false, status: 400, json: async () => ({ error: "unsupported write" }) };
  }
  runQuery(uid, query) {
    const field = query.orderBy[0].field.fieldPath;
    let rows = this.docsUnder(uid)
      .filter(([, doc]) => doc.fields[field] && "timestampValue" in doc.fields[field]);
    if (query.where) {
      const cutoff = query.where.fieldFilter.value.timestampValue;
      rows = rows.filter(([, doc]) => doc.fields[field].timestampValue > cutoff);
    }
    rows.sort((a, b) => {
      const ta = a[1].fields[field].timestampValue;
      const tb = b[1].fields[field].timestampValue;
      return ta < tb ? -1 : ta > tb ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    if (query.limit) rows = rows.slice(0, query.limit);
    return rows.map(([name, doc]) => ({
      document: { name: `projects/test/databases/(default)/documents/${name}`, fields: doc.fields }
    }));
  }
}

// ---- Per-instance DOM stubs ----

function makeElement(tag = "div") {
  const listeners = new Map();
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(),
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    title: "",
    href: "",
    className: "",
    dataset: {},
    style: {},
    children: [],
    listeners,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : Boolean(force); if (on) classes.add(name); else classes.delete(name); return on; },
      contains: (name) => classes.has(name)
    },
    setAttribute(name, value) { this["@" + name] = String(value); },
    getAttribute(name) { return this["@" + name] ?? null; },
    removeAttribute(name) { delete this["@" + name]; },
    append(...nodes) { this.children.push(...nodes); },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) { const list = listeners.get(type) || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
    dispatch(type, event = {}) { for (const fn of [...(listeners.get(type) || [])]) fn({ type, ...event }); }
  };
}

class Instance {
  constructor(harness, name, options) {
    this.harness = harness;
    this.name = name;
    this.closed = false;
    this.frozen = false;
    this.events = [];        // queued DOM events while frozen (storage, ...)
    this.timers = new Map(); // id -> { at, fn, interval }
    this.nextTimerId = 1;
    this.notifications = [];
    this.warnings = [];
    this.authCallback = null;
    this.elements = new Map();
    this.windowListeners = new Map();
    this.documentListeners = new Map();
    this.hidden = !(options.visible ?? true);
    this.search = options.search || "";
    this.build();
  }

  element(selector) {
    if (!this.elements.has(selector)) this.elements.set(selector, makeElement());
    return this.elements.get(selector);
  }

  build() {
    const inst = this;
    const harness = this.harness;
    const breakButtons = [5, 10].map((minutes) => { const el = makeElement("button"); el.dataset.breakMinutes = String(minutes); return el; });

    const document = {
      get hidden() { return inst.hidden; },
      get visibilityState() { return inst.hidden ? "hidden" : "visible"; },
      title: "",
      querySelector: (selector) => inst.element(selector),
      querySelectorAll: (selector) => (selector === "[data-break-minutes]" ? breakButtons : []),
      getElementById: (id) => inst.element("#" + id),
      createElement: (tag) => makeElement(tag),
      addEventListener: (type, fn) => { if (!inst.documentListeners.has(type)) inst.documentListeners.set(type, []); inst.documentListeners.get(type).push(fn); },
      removeEventListener: () => {}
    };
    this.breakButtons = breakButtons;

    class FakeNotification {
      constructor(title, options) { this.title = title; this.body = options && options.body; inst.notifications.push(this); }
      close() {}
      static requestPermission() { return Promise.resolve(FakeNotification.permission); }
    }
    FakeNotification.permission = "granted";

    class FakeAudioContext {
      constructor() { this.state = "suspended"; this.currentTime = 0; }
      resume() { return Promise.resolve(); }
    }

    const timers = {
      setTimeout: (fn, ms, ...args) => inst.addTimer(fn, ms, null, args),
      setInterval: (fn, ms, ...args) => inst.addTimer(fn, ms, ms, args),
      clearTimeout: (id) => inst.timers.delete(id),
      clearInterval: (id) => inst.timers.delete(id)
    };

    const sandbox = {
      console: {
        log: () => {},
        info: () => {},
        warn: (...args) => inst.warnings.push(args.map(String).join(" ")),
        error: (...args) => inst.warnings.push(args.map(String).join(" "))
      },
      document,
      navigator: { onLine: true, locks: { request: (name, options, callback) => harness.locks.request(inst, name, options, callback) } },
      localStorage: harness.storage.forInstance(inst),
      location: { search: this.search, hash: "", pathname: "/my-pomodoro/app/index.html" },
      Notification: FakeNotification,
      AudioContext: FakeAudioContext,
      fetch: (url, options) => harness.firestore.fetch(url, options),
      crypto: nodeCrypto.webcrypto,
      TextEncoder,
      URLSearchParams,
      confirm: () => true,
      alert: () => {},
      __clock: harness.clock,
      __setAuthCallback: (callback) => { sandbox.__authCallback = callback; },
      __authCallback: null,
      ...timers
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.addEventListener = (type, fn) => { if (!inst.windowListeners.has(type)) inst.windowListeners.set(type, []); inst.windowListeners.get(type).push(fn); };
    sandbox.removeEventListener = () => {};
    sandbox.focus = () => {};

    this.context = vm.createContext(sandbox);
    // Virtual Date: `new Date()` and `Date.now()` read the shared clock.
    vm.runInContext(`
      const __RealDate = Date;
      class VirtualDate extends __RealDate {
        constructor(...args) { if (args.length === 0) super(__clock.now()); else super(...args); }
        static now() { return __clock.now(); }
      }
      globalThis.Date = VirtualDate;
    `, this.context, { filename: "virtual-date.js" });
    this.run(MAIN_SCRIPT, "app-index-html-main-script.js");
    // Inject auth through the app's own seam, as the module script does.
    this.run(`window.PomodoroSync.start({
      onAuthChange(callback) { __setAuthCallback(callback); },
      async signIn() {},
      signOutUser() { if (__authCallback) __authCallback(null); }
    })`);
  }

  run(code, filename = "test-eval.js") {
    return vm.runInContext(code, this.context, { filename });
  }

  addTimer(fn, ms, interval, args) {
    const id = this.nextTimerId++;
    this.timers.set(id, { at: this.harness.clock.now() + Math.max(0, Number(ms) || 0), fn, interval, args });
    return id;
  }

  queueEvent(type, event) {
    this.events.push({ type, event });
  }

  // Deliver queued DOM events (storage etc.) unless frozen.
  deliverEvents() {
    if (this.frozen || this.closed) return;
    const pending = this.events.splice(0);
    for (const { type, event } of pending) this.dispatchWindow(type, event);
  }

  dispatchWindow(type, event = {}) {
    for (const fn of [...(this.windowListeners.get(type) || [])]) fn({ type, ...event });
  }
  dispatchDocument(type, event = {}) {
    for (const fn of [...(this.documentListeners.get(type) || [])]) fn({ type, ...event });
  }

  // ---- Actions a person (or the browser) takes on this instance ----
  click(selector) { this.element(selector).dispatch("click"); return drainMicrotasks(); }
  clickBreak(minutes) { this.breakButtons.find((b) => b.dataset.breakMinutes === String(minutes)).dispatch("click"); return drainMicrotasks(); }
  async show() { this.hidden = false; this.dispatchDocument("visibilitychange"); this.dispatchWindow("focus"); await drainMicrotasks(); }
  async hide() { this.hidden = true; this.dispatchDocument("visibilitychange"); this.dispatchWindow("blur"); await drainMicrotasks(); }
  freeze() { this.frozen = true; }
  async thaw() { this.frozen = false; this.deliverEvents(); await drainMicrotasks(); }
  async close() {
    this.dispatchWindow("beforeunload");
    this.dispatchWindow("pagehide");
    this.closed = true;
    this.timers.clear();
    this.harness.locks.releaseAll(this);
    await drainMicrotasks();
  }
  async signIn(uid = "uid-test", email = "hector@example.com") {
    const callback = this.run("__authCallback");
    callback({ uid, email, getToken: async () => "token-" + uid });
    await drainMicrotasks(20);
  }
  async signOut() {
    const callback = this.run("__authCallback");
    callback(null);
    await drainMicrotasks();
  }

  // ---- Reads ----
  get state() { return this.run("state"); }
  text(selector) { return this.element(selector).textContent; }
}

class Harness {
  constructor(options = {}) {
    this.clock = new Clock(options.startIso);
    this.storage = new SharedStorage();
    this.locks = new SharedLocks();
    this.firestore = new FakeFirestore(this.clock);
    this.instances = [];
  }

  async open(name, options = {}) {
    const inst = new Instance(this, name, options);
    this.storage.instances.add(inst);
    this.instances.push(inst);
    await drainMicrotasks(20);
    return inst;
  }

  // Preload the shared storage before any instance opens.
  seedStorage(key, value) {
    this.storage.map.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  // Move the clock forward, running every due timer of every live instance
  // in time order, delivering queued events and letting promises settle.
  async advance(ms) {
    const target = this.clock.now() + ms;
    for (;;) {
      for (const inst of this.instances) inst.deliverEvents();
      await drainMicrotasks(4);
      let earliest = null;
      for (const inst of this.instances) {
        if (inst.frozen || inst.closed) continue;
        for (const [id, timer] of inst.timers) {
          if (timer.at <= target && (!earliest || timer.at < earliest.timer.at)) earliest = { inst, id, timer };
        }
      }
      if (!earliest) break;
      const { inst, id, timer } = earliest;
      this.clock.nowMs = Math.max(this.clock.nowMs, timer.at);
      // A thawed tab gets one catch-up tick, not one per missed second —
      // browsers coalesce a suspended interval the same way.
      if (timer.interval != null) timer.at = Math.max(timer.at, this.clock.nowMs) + timer.interval;
      else inst.timers.delete(id);
      timer.fn(...(timer.args || []));
      await drainMicrotasks(4);
    }
    this.clock.nowMs = target;
    for (const inst of this.instances) inst.deliverEvents();
    await drainMicrotasks(4);
  }

  // Let promises settle and events deliver without moving the clock.
  async flush() { await this.advance(0); }

  storageState() { return this.storage.json("focus-sessions.v1"); }
  pending() { return this.storage.json("focus-sessions.pending.v1") || []; }
}

module.exports = { Harness, drainMicrotasks, MAIN_SCRIPT };
