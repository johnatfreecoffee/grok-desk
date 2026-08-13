#!/usr/bin/env node
/**
 * SessionStore isolation unit tests.
 * Usage: node --experimental-strip-types scripts/session-store-unit.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const storeUrl = pathToFileURL(path.join(here, "../web/src/lib/sessionStore.ts")).href;

const {
  SessionStore,
  hydrateMessages,
  createPendingId,
  isPendingId,
  shouldPaint,
} = await import(storeUrl);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("✓", name);
}

test("shouldPaint requires both ids equal", () => {
  assert.equal(shouldPaint("a", "a"), true);
  assert.equal(shouldPaint("a", "b"), false);
  assert.equal(shouldPaint("a", null), false);
  assert.equal(shouldPaint(null, "a"), false);
  assert.equal(shouldPaint(null, null), false);
});

test("newChat while A working does not copy A messages", () => {
  const store = new SessionStore();
  const a = store.view("sess-a", "/tmp/proj");
  store.setMessages("sess-a", [
    { id: "u1", role: "user", content: "ALPHA" },
    { id: "a1", role: "assistant", content: "thinking…", streaming: true },
  ]);
  store.markLive("sess-a");
  const pending = store.createPending("/tmp/proj");
  assert.ok(isPendingId(pending.id));
  assert.equal(pending.messages.length, 0);
  assert.notEqual(pending.id, "sess-a");
  assert.equal(store.ensure("sess-a").messages[0].content, "ALPHA");
  assert.equal(store.viewingId, pending.id);
  assert.equal(store.isLive("sess-a"), true);
  assert.equal(pending.writable, true);
});

test("applyUpdate without sessionId is a no-op", () => {
  const store = new SessionStore();
  store.view("b");
  store.setMessages("b", [{ id: "keep", role: "user", content: "BRAVO" }]);
  const r = store.applyUpdate(null, {
    sessionUpdate: "agent_message_chunk",
    content: { text: "leak" },
  });
  assert.equal(r, null);
  assert.equal(store.droppedUntagged, 1);
  assert.equal(store.ensure("b").messages.length, 1);
  assert.equal(store.ensure("b").messages[0].content, "BRAVO");
});

test("applyUpdate for A while viewing B only mutates A", () => {
  const store = new SessionStore();
  store.ensure("a");
  store.setMessages("a", [{ id: "ua", role: "user", content: "ALPHA" }]);
  store.view("b");
  store.setMessages("b", [{ id: "ub", role: "user", content: "BRAVO" }]);
  const r = store.applyUpdate("a", {
    sessionUpdate: "agent_message_chunk",
    content: { text: "alpha-reply" },
  });
  assert.ok(r);
  assert.equal(r.viewing, false);
  const aText = store.ensure("a").messages.map((m) => m.content).join("|");
  const bText = store.ensure("b").messages.map((m) => m.content).join("|");
  assert.ok(aText.includes("ALPHA"));
  assert.ok(aText.includes("alpha-reply"));
  assert.equal(bText, "BRAVO");
  assert.ok(!bText.includes("alpha-reply"));
});

test("hydrate keeps user prompt when disk history is empty", () => {
  const cached = [{ id: "desk_u_1", role: "user", content: "my first prompt" }];
  const out = hydrateMessages([], cached, null);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "my first prompt");
});

test("hydrate does not splice another chat's rows — caller isolation", () => {
  const disk = [{ id: "ua", role: "user", content: "ALPHA" }];
  const cached = [{ id: "ub", role: "user", content: "BRAVO" }];
  // If someone wrongly passes mixed sources, content-key keeps both (different text)
  const mixed = hydrateMessages(disk, cached, null);
  assert.equal(mixed.length, 2);
});

test("onTurnEnd(A) while viewing B does not clear B draft", () => {
  const store = new SessionStore();
  store.ensure("a");
  store.setMessages("a", [{ id: "ua", role: "user", content: "ALPHA" }]);
  store.applyUpdate("a", {
    sessionUpdate: "agent_message_chunk",
    content: { text: "done-a" },
  });
  store.view("b");
  store.setMessages("b", [{ id: "ub", role: "user", content: "BRAVO" }]);
  store.applyUpdate("b", {
    sessionUpdate: "agent_message_chunk",
    content: { text: "partial-b" },
  });
  const end = store.applyTurnEnd("a");
  assert.equal(end.viewing, false);
  assert.equal(store.isLive("a"), false);
  assert.equal(store.isLive("b"), true);
  assert.ok(store.ensure("b").draft);
  assert.ok(store.ensure("b").messages.some((m) => m.content.includes("partial-b")));
  assert.ok(store.ensure("a").messages.some((m) => m.content.includes("done-a")));
  assert.ok(!store.ensure("a").messages.some((m) => String(m.content).includes("BRAVO")));
});

test("rebase pending → real does not copy a different session", () => {
  const store = new SessionStore();
  store.setMessages("sess-a", [{ id: "ua", role: "user", content: "ALPHA" }]);
  store.markLive("sess-a");
  const pending = store.createPending("/tmp/x");
  const real = store.rebase(pending.id, "sess-b");
  assert.equal(real.id, "sess-b");
  assert.equal(real.messages.length, 0);
  assert.equal(store.ensure("sess-a").messages[0].content, "ALPHA");
  assert.equal(store.viewingId, "sess-b");
  assert.equal(store.isLive("sess-a"), true);
});

test("pending ids are recognized", () => {
  const id = createPendingId();
  assert.equal(isPendingId(id), true);
  assert.equal(isPendingId("abc-uuid"), false);
});

console.log(`\n${passed} tests passed`);
