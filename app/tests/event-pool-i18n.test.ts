import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../messages/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const en = load("en");
const zh = load("zh");

const POOL_KEYS = [
  "dockTabStageTelemetry", "dockTabEventPool", "poolHeaderTrigger", "poolHeaderTriggerHint",
  "poolWithdrawBtn", "poolWithdrawHint", "poolStatusPendingShort", "poolStatusReadAt",
  "poolStatusWithdrawn", "poolStatusWithdrawnAt", "poolOpenInOverviewHint",
  "poolReceiptShioriReadSingle", "poolReceiptShioriReadMulti", "poolReceiptHumanResolved",
  "poolReceiptJumpSource", "poolReceiptLatency", "locatingPoolEventBanner", "poolPanelAria",
  "poolStatPendingInbound", "poolStatPendingOutbound", "poolStatTotalRetained", "poolComposeBtn",
  "poolFilterAll", "poolFilterPending", "poolFilterInbound", "poolFilterOutbound",
  "poolSearchPlaceholder", "poolEmptyAllTitle", "poolEmptyAllDesc", "poolEmptyFiltered",
  "poolKindInboundMessage", "poolKindInboundReply", "poolReplyingToSeq", "poolLifecycleSent",
  "poolLifecycleEmitted", "poolLifecycleRead", "poolLifecycleResolved", "poolLifecycleWithdrawn",
  "poolLifecycleAwaitingShiori", "poolLifecycleAwaitingHuman", "poolLifecycleElapsed",
  "poolLocateInStreamBtn",
  "poolBodyExpand", "poolBodyCollapse", "poolSearchClear",
];

function paths(node: unknown, prefix = ""): string[] {
  if (node === null || typeof node !== "object") return [prefix];
  return Object.entries(node).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
}

const tokens = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

test("en.json and zh.json have identical key sets", () => {
  assert.deepEqual(paths(en).sort(), paths(zh).sort());
});

test("Event Pool UX keys exist, are non-empty, and keep placeholders", () => {
  assert.equal(POOL_KEYS.length, 45);
  const e = en.shioriCockpit as Record<string, unknown>;
  const z = zh.shioriCockpit as Record<string, unknown>;
  for (const key of POOL_KEYS) {
    assert.equal(typeof e[key], "string", `en ${key}`);
    assert.equal(typeof z[key], "string", `zh ${key}`);
    assert.ok((e[key] as string).trim() && (z[key] as string).trim(), `empty ${key}`);
    assert.deepEqual(tokens(e[key] as string), tokens(z[key] as string), `placeholders ${key}`);
  }
  const ek = Object.keys(e);
  assert.deepEqual(ek.slice(-45), POOL_KEYS);
  assert.deepEqual(Object.keys(z).slice(-45), POOL_KEYS);
});
