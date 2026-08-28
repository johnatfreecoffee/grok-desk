#!/usr/bin/env node
/**
 * Automations next-run math + grok-automation fence parse.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { computeNextRun } = await import(pathToFileURL(path.join(here, "../daemon/automations.js")).href);
const { extractAutomationFence } = await import(
  pathToFileURL(path.join(here, "../web/src/lib/automations.ts")).href
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("✓", name);
}

test("hourly advances to the next hour at :mm", () => {
  const from = new Date("2026-08-18T10:05:00");
  const next = new Date(computeNextRun({ frequency: "hourly", time: "09:15" }, from));
  assert.equal(next.getHours(), 10);
  assert.equal(next.getMinutes(), 15);
});

test("daily rolls to tomorrow when today's slot passed", () => {
  const from = new Date("2026-08-18T10:05:00");
  const next = new Date(computeNextRun({ frequency: "daily", time: "09:00" }, from));
  assert.equal(next.toISOString().slice(0, 10), "2026-08-19");
  assert.equal(next.getHours(), 9);
});

test("weekdays skip Saturday", () => {
  const sat = new Date("2026-08-22T10:00:00"); // Saturday
  const next = new Date(computeNextRun({ frequency: "weekdays", time: "09:00" }, sat));
  assert.equal(next.getDay(), 1);
});

test("once returns the next clock time", () => {
  const from = new Date("2026-08-18T08:00:00");
  const next = new Date(computeNextRun({ frequency: "once", time: "09:30" }, from));
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);
});

test("fence extracts JSON and strips the block", () => {
  const text = 'ok\n```grok-automation\n{"title":"AM","prompt":"brief me","frequency":"daily"}\n```\n';
  const { cleaned, payload } = extractAutomationFence(text);
  assert.equal(payload?.prompt, "brief me");
  assert.equal(payload?.title, "AM");
  assert.equal(payload?.frequency, "daily");
  assert.equal(cleaned.includes("grok-automation"), false);
  assert.equal(cleaned, "ok");
});

test("bad fence is ignored", () => {
  const { cleaned, payload } = extractAutomationFence("```grok-automation\nnope\n```");
  assert.equal(payload, null);
  assert.ok(cleaned.includes("nope") === false || payload === null);
});

console.log(`\n${passed} automation tests passed`);
