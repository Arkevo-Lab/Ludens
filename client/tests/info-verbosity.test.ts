import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../lib/locale";
import {
  DEFAULT_INFO_VERBOSITY,
  getLiveVerbosityFlags,
  normalizeInfoVerbosity,
  resetInfoVerbosityCache,
  setInfoVerbosity,
} from "../lib/use-info-verbosity";
import { SettingsView } from "../features/workspaces/settings-view";
import type { PetFollow } from "../features/pet/pet-follow";

test("normalizeInfoVerbosity clamps invalid values to default L3 and accepts 1..5", () => {
  assert.equal(normalizeInfoVerbosity(1), 1);
  assert.equal(normalizeInfoVerbosity("2"), 2);
  assert.equal(normalizeInfoVerbosity(3), 3);
  assert.equal(normalizeInfoVerbosity("4"), 4);
  assert.equal(normalizeInfoVerbosity(5), 5);
  assert.equal(normalizeInfoVerbosity(0), DEFAULT_INFO_VERBOSITY);
  assert.equal(normalizeInfoVerbosity(6), DEFAULT_INFO_VERBOSITY);
  assert.equal(normalizeInfoVerbosity("invalid"), DEFAULT_INFO_VERBOSITY);
  assert.equal(normalizeInfoVerbosity(null), DEFAULT_INFO_VERBOSITY);
});

test("getLiveVerbosityFlags follows the L1..L5 progressive disclosure ladder", () => {
  assert.deepEqual(getLiveVerbosityFlags(1), {
    showSteps: false,
    showSystemEvents: false,
    showModelInputs: false,
    expandStepsByDefault: false,
    expandSystemEventsByDefault: false,
    expandModelInputsByDefault: false,
  });

  assert.deepEqual(getLiveVerbosityFlags(2), {
    showSteps: true,
    showSystemEvents: false,
    showModelInputs: false,
    expandStepsByDefault: false,
    expandSystemEventsByDefault: false,
    expandModelInputsByDefault: false,
  });

  assert.deepEqual(getLiveVerbosityFlags(3), {
    showSteps: true,
    showSystemEvents: true,
    showModelInputs: true,
    expandStepsByDefault: false,
    expandSystemEventsByDefault: false,
    expandModelInputsByDefault: false,
  });

  assert.deepEqual(getLiveVerbosityFlags(4), {
    showSteps: true,
    showSystemEvents: true,
    showModelInputs: true,
    expandStepsByDefault: true,
    expandSystemEventsByDefault: false,
    expandModelInputsByDefault: false,
  });

  assert.deepEqual(getLiveVerbosityFlags(5), {
    showSteps: true,
    showSystemEvents: true,
    showModelInputs: true,
    expandStepsByDefault: true,
    expandSystemEventsByDefault: true,
    expandModelInputsByDefault: true,
  });
});

test("SettingsView renders the 5-level Information Verbosity selector in General settings", () => {
  resetInfoVerbosityCache();
  setInfoVerbosity(4);

  const followStub = {
    value: null,
    loading: false,
    pending: false,
    error: null,
    uncertain: false,
    refresh: async () => {},
    setTarget: async () => {},
  } as unknown as PetFollow;

  const html = renderToStaticMarkup(
    createElement(
      LocaleProvider,
      null,
      createElement(SettingsView, {
        follow: followStub,
        projects: [],
        initialCategory: "general",
      }),
    ),
  );

  assert.match(html, /data-info-verbosity-picker=""/);
  assert.match(html, /data-verbosity-level="1"/);
  assert.match(html, /data-verbosity-level="2"/);
  assert.match(html, /data-verbosity-level="3"/);
  assert.match(html, /data-verbosity-level="4"/);
  assert.match(html, /data-verbosity-level="5"/);
  assert.match(html, /data-info-verbosity-detail=""/);

  resetInfoVerbosityCache();
});
