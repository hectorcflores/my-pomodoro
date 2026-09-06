// Two instances of the app on one device (two tabs, or a tab beside the
// installed window) share one localStorage. These scenarios pin down who
// may write it, who counts time, and what survives a stale instance
// waking up. Scenario 1 is the 2026-09-05 incident verbatim.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Harness } = require("./harness");

const STATE_KEY = "focus-sessions.v1";
const OWNER_LOCK = "focus-sessions-owner";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Array.from lifts vm-realm arrays into this realm so deepEqual can compare them.
const todayIds = (sessions, date = "2026-09-05") => Array.from(sessions).filter((s) => s.date === date).map((s) => s.id);
const notificationsTitled = (inst, title) => inst.notifications.filter((n) => n.title === title).length;

test("smoke: one instance runs a 60-second session to completion", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=60" });
  await a.click("#mainButton");
  assert.ok(a.state.activeSession, "session started");
  await h.advance(60 * 1000);
  assert.equal(a.state.activeSession, null);
  assert.equal(todayIds(a.state.sessions).length, 1);
  assert.equal(notificationsTitled(a, "Done"), 1);
  assert.equal(a.text("#state"), "1 session today");
  assert.deepEqual(todayIds(h.storageState().sessions), todayIds(a.state.sessions));
  assert.equal(h.pending().length, 1, "signed out: the session waits in the outbox");
});

test("1. the incident: a frozen tab wakes up, gets focus and syncs — nothing is lost", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=60" });
  await a.click("#mainButton");
  const s1 = a.state.activeSession.id;
  await h.advance(24 * 1000);
  await a.hide();
  a.freeze();

  // A second tab picks up the running session and finishes it, then a
  // second one, all signed out.
  const b = await h.open("B", { search: "?seconds=60" });
  await b.show();
  await h.advance(40 * 1000);
  assert.equal(b.state.activeSession, null, "B completed S1");
  await b.click("#mainButton");
  const s2 = b.state.activeSession.id;
  await h.advance(60 * 1000);
  assert.deepEqual(todayIds(h.storageState().sessions), [s1, s2]);

  // The stale tab wakes, signs in and gets focus.
  await a.thaw();
  await a.signIn();
  await a.show();
  await h.advance(5 * 1000);

  const stored = h.storageState();
  assert.equal(stored.activeSession, null, "no ghost session resurrected");
  assert.deepEqual(todayIds(stored.sessions), [s1, s2], "both of today's sessions survive locally");
  assert.deepEqual(h.firestore.liveSessions("uid-test").sort(), [s1, s2].sort(), "both reached the server");
  assert.deepEqual(todayIds(a.state.sessions), [s1, s2]);
  assert.equal(h.pending().length, 0);
});

test("2. a stale signed-in tab getting focus does not overwrite what another tab completed", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=60" });
  await a.signIn();
  await a.hide();
  a.freeze();

  const b = await h.open("B", { search: "?seconds=60" });
  await b.show();
  await b.click("#mainButton");
  const s = b.state.activeSession.id;
  await h.advance(90 * 1000);
  assert.deepEqual(todayIds(h.storageState().sessions), [s]);

  await a.thaw();
  await a.show();
  await h.advance(5 * 1000);

  assert.deepEqual(todayIds(h.storageState().sessions), [s], "S still in storage after A's focus + sync");
  assert.deepEqual(h.firestore.liveSessions("uid-test"), [s]);
  assert.equal(h.pending().length, 0);
});

test("3. closing a stale tab writes nothing", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=60" });
  await a.hide();
  a.freeze();

  const b = await h.open("B", { search: "?seconds=60" });
  await b.show();
  await b.click("#mainButton");
  const s = b.state.activeSession.id;
  await h.advance(60 * 1000);

  await a.thaw();
  await a.close();
  await h.flush();
  assert.deepEqual(todayIds(h.storageState().sessions), [s], "S still in storage after A closed");
});

test("4. exactly one instance counts time and completes a session", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=60" });
  await a.signIn();
  await a.click("#mainButton");
  await h.advance(5 * 1000);

  const b = await h.open("B", { search: "?seconds=60" });
  await b.signIn();
  await b.show();
  await h.advance(25 * 1000);
  const elapsed = h.storageState().activeSession.elapsedMs;
  assert.ok(Math.abs(elapsed - 30 * 1000) <= 2000, `elapsed ${elapsed} ≈ 30s`);

  await h.advance(35 * 1000);
  assert.equal(notificationsTitled(a, "Done") + notificationsTitled(b, "Done"), 1, "one Done banner in total");
  assert.equal(h.firestore.liveSessions("uid-test").length, 1);
  const sinceTakeover = h.storage.writes.filter((w) => w.key === STATE_KEY && w.at > h.clock.now() - 60 * 1000);
  assert.ok(sinceTakeover.length > 0);
  assert.ok(sinceTakeover.every((w) => w.by === "B"), "once B is in front, only B writes the state");
});

test("5. the outbox keeps a session queued during an in-flight flush", async () => {
  const h = new Harness();
  const a = await h.open("A");
  await a.signIn();
  const row = (id) => `({ id: "${id}", startedAt: new Date(Date.now() - 60000).toISOString(), completedAt: new Date().toISOString(), durationSeconds: 60, clientId: clientId(), date: todayKey() })`;
  a.run(`addPending(${row("p1")})`);
  h.firestore.holdWrites = true;
  const flush = a.run("flushPending()");
  await h.flush();
  a.run(`addPending(${row("p2")})`);
  h.firestore.release();
  await flush;
  await h.flush();
  assert.deepEqual(h.pending().map((r) => r.id), ["p2"], "p2 was queued mid-flight and must still be pending");
  assert.deepEqual(h.firestore.liveSessions("uid-test"), ["p1"]);
});

test("6. the tab in front takes over the clock; the old owner stops writing; closing hands over", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=600" });
  await a.click("#mainButton");
  await h.advance(10 * 1000);

  const b = await h.open("B", { search: "?seconds=600" });
  await b.show();
  await h.flush();
  assert.equal(h.locks.holder(OWNER_LOCK), "B");
  const writesBefore = h.storage.writes.length;
  await h.advance(10 * 1000);
  const recent = h.storage.writes.slice(writesBefore).filter((w) => w.key === STATE_KEY);
  assert.ok(recent.length > 0);
  assert.ok(recent.every((w) => w.by === "B"), "only B writes after taking over");
  let elapsed = h.storageState().activeSession.elapsedMs;
  assert.ok(Math.abs(elapsed - 20 * 1000) <= 2000, `elapsed ${elapsed} ≈ 20s after takeover`);
  assert.equal(a.text("#time"), b.text("#time"), "the mirror shows the owner's countdown");

  // The owner closes: the other tab picks the clock up without a gap.
  await b.close();
  await h.advance(10 * 1000);
  assert.equal(h.locks.holder(OWNER_LOCK), "A");
  elapsed = h.storageState().activeSession.elapsedMs;
  assert.ok(Math.abs(elapsed - 30 * 1000) <= 2000, `elapsed ${elapsed} ≈ 30s after handover`);
});

test("7. a session unseen for two days is dropped, not resumed and logged today", async () => {
  const h = new Harness();
  h.seedStorage(STATE_KEY, {
    sessions: [],
    activeSession: {
      id: "ghost",
      startedAt: new Date(h.clock.now() - 2 * 24 * HOUR).toISOString(),
      durationSeconds: 1800,
      elapsedMs: 24 * MIN,
      lastSeenAt: new Date(h.clock.now() - 2 * 24 * HOUR + 24 * MIN).toISOString(),
      paused: false
    }
  });
  const a = await h.open("A");
  assert.equal(a.state.activeSession, null, "ghost discarded on load");
  await h.advance(10 * MIN);
  assert.equal(todayIds(a.state.sessions).length, 0, "nothing logged");
  assert.equal(notificationsTitled(a, "Done"), 0);
  assert.equal(h.storageState().activeSession, null);
});

test("8. witnessed time still holds: short gaps count, long gaps hold, abandonment drops", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=1800" });
  await a.click("#mainButton");
  await h.advance(10 * 1000);

  // A one-minute gap (throttled tab) counts in full.
  a.freeze();
  await h.advance(60 * 1000);
  await a.thaw();
  await h.advance(1000);
  let elapsed = a.state.activeSession.elapsedMs;
  assert.ok(Math.abs(elapsed - 71 * 1000) <= 2000, `elapsed ${elapsed} ≈ 71s after a 60s gap`);

  // An hour asleep credits at most the 90-second cap and keeps the session.
  a.freeze();
  await h.advance(HOUR);
  await a.thaw();
  await h.advance(1000);
  elapsed = a.state.activeSession.elapsedMs;
  assert.ok(elapsed <= 71 * 1000 + 90 * 1000 + 2000, `elapsed ${elapsed} capped after an hour`);
  assert.ok(a.state.activeSession, "session survives an hour away");

  // Three hours away is abandonment: the session is dropped silently.
  a.freeze();
  await h.advance(3 * HOUR);
  await a.thaw();
  await h.advance(1000);
  assert.equal(a.state.activeSession, null, "dropped after three hours unseen");
  assert.equal(todayIds(a.state.sessions).length, 0);
  assert.equal(notificationsTitled(a, "Done"), 0);
});

test("9. an instance that still believes it owns the clock cannot write once another took the token", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=600" });
  await a.click("#mainButton");
  const b = await h.open("B", { search: "?seconds=600" });
  await b.show();
  await h.advance(2000);
  // Simulate the thaw race: A's lock rejection has not been delivered yet.
  a.run("isOwner = true");
  a.run("state.sessions = []; state.activeSession = null");
  const before = h.storage.getItem(STATE_KEY);
  a.run("saveState()");
  assert.equal(h.storage.getItem(STATE_KEY), before, "A's stale write was refused");
  assert.equal(a.run("isOwner"), false, "A demoted itself");
});

test("10. interacting with a mirror takes over first, then acts", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=600" });
  await a.click("#mainButton");
  await h.advance(5 * 1000);
  const b = await h.open("B", { search: "?seconds=600", visible: false });
  await h.flush();
  assert.equal(h.locks.holder(OWNER_LOCK), "A");
  await b.click("#mainButton"); // pause, from the background tab
  await h.flush();
  assert.equal(h.locks.holder(OWNER_LOCK), "B");
  assert.equal(h.storageState().activeSession.paused, true);
  await h.advance(5 * 1000);
  assert.equal(a.state.activeSession.paused, true, "the old owner mirrors the pause");
});
