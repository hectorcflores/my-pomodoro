// Two ways into one account (Google, or email + password set from a
// signed-in device) must land on the same uid — and the app must treat a
// second sign-in with the same uid as a resume, not as a new account. A
// genuinely different uid drops the local cache and adopts the server's
// list. Both rules are what the work-laptop password route relies on.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Harness } = require("./harness");

const ids = (sessions) => Array.from(sessions).map((s) => s.id);

test("same uid again: sessions survive and the outbox flushes into that account", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=60" });
  await a.signIn("uid-hector", "hector@gmail.com");
  await a.click("#mainButton");
  await h.advance(60 * 1000);
  const s1 = ids(a.state.sessions)[0];
  assert.deepEqual(h.firestore.liveSessions("uid-hector"), [s1]);

  await a.signOut();
  await a.click("#mainButton");
  await h.advance(60 * 1000);
  assert.equal(h.pending().length, 1, "signed out: the second session waits in the outbox");

  // Password sign-in on the same account: identical uid, different route.
  await a.signIn("uid-hector", "hector@gmail.com");
  await h.flush();
  assert.equal(ids(a.state.sessions).length, 2, "nothing was wiped");
  assert.equal(h.pending().length, 0, "the outbox flushed");
  assert.deepEqual(h.firestore.liveSessions("uid-hector").sort(), ids(a.state.sessions).sort());
});

test("a different uid drops the local cache and adopts that account's server list", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=60" });
  await a.signIn("uid-hector", "hector@gmail.com");
  await a.click("#mainButton");
  await h.advance(60 * 1000);
  const s1 = ids(a.state.sessions)[0];

  await a.signOut();
  await a.click("#mainButton");
  await h.advance(60 * 1000);
  assert.equal(h.pending().length, 1);

  await a.signIn("uid-other", "someone@example.com");
  await h.flush();
  assert.deepEqual(ids(a.state.sessions), [], "the other account starts from its own (empty) server list");
  assert.equal(h.pending().length, 0, "the queued session was not pushed into the other account");
  assert.deepEqual(h.firestore.liveSessions("uid-other"), []);
  assert.deepEqual(h.firestore.liveSessions("uid-hector"), [s1], "the first account's data is untouched on the server");

  await a.signIn("uid-hector", "hector@gmail.com");
  await h.flush();
  assert.deepEqual(ids(a.state.sessions), [s1], "coming back adopts the server list again");
});

test("the dialog routes email + password and set-password through the auth service", async () => {
  const h = new Harness();
  const a = await h.open("A");
  const submit = { preventDefault() {} };

  await a.click("#accountBtn");
  a.element("#passwordEmail").value = " hector@gmail.com ";
  a.element("#passwordInput").value = "correct horse battery";
  a.element("#passwordForm").dispatch("submit", submit);
  await h.flush();
  assert.deepEqual(a.authCalls, [{ op: "signIn", method: "password", email: "hector@gmail.com", password: "correct horse battery" }]);

  a.element("#googleSignInBtn").dispatch("click");
  await h.flush();
  assert.equal(a.authCalls[1].method, "google");

  await a.signIn("uid-hector", "hector@gmail.com");
  await a.click("#accountBtn");
  assert.equal(a.text("#authEmail"), "hector@gmail.com", "the dialog names the account the password will attach to");
  a.element("#setPasswordInput").value = "short";
  a.element("#setPasswordConfirm").value = "short";
  a.element("#setPasswordForm").dispatch("submit", submit);
  await h.flush();
  assert.equal(a.authCalls.length, 2, "a short password never reaches the service");
  assert.equal(a.text("#authInHint"), "Use at least 12 characters.");

  a.element("#setPasswordInput").value = "correct horse battery";
  a.element("#setPasswordConfirm").value = "correct horse battery!";
  a.element("#setPasswordForm").dispatch("submit", submit);
  await h.flush();
  assert.equal(a.authCalls.length, 2, "mismatched passwords never reach the service");

  a.element("#setPasswordConfirm").value = "correct horse battery";
  a.element("#setPasswordForm").dispatch("submit", submit);
  await h.flush();
  assert.deepEqual(a.authCalls[2], { op: "setPassword", password: "correct horse battery" });
  assert.match(a.text("#authInHint"), /^Password set\./);
});

// Managed laptops (VPN clients, security agents) make Chrome report
// navigator.onLine=false while every request succeeds. The pill must reflect
// what the network actually did, and the app must still try.
test("a browser that wrongly claims to be offline still syncs", async () => {
  const h = new Harness();
  const a = await h.open("A", { search: "?seconds=60" });
  a.run("navigator.onLine = false");
  await a.signIn("uid-hector", "hector@gmail.com");
  await h.flush();
  assert.match(a.text("#syncStatus"), /^Synced/);
  await a.click("#mainButton");
  await h.advance(60 * 1000);
  assert.deepEqual(h.firestore.liveSessions("uid-hector"), ids(a.state.sessions));
  assert.equal(h.pending().length, 0);
});
