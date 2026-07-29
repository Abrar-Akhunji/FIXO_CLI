/**
 * direct-mode-config.test.ts — Phase 1.1 config-layer guarantees.
 *
 * Covers:
 *  1. Fresh installs default to `provider_mode: 'direct'`.
 *  2. Back-compat: existing configs that predate v1.1 and have a
 *     FreeLLMAPI key are inferred as `'proxy'` (never silently
 *     flipped to direct, which would break working installs).
 *  3. Back-compat: existing configs that predate v1.1 and have no
 *     FreeLLMAPI key are inferred as `'direct'`.
 *  4. Round-trip: saving a direct-mode config and reloading it
 *     yields the same `provider_mode` and `directProvider` shape.
 *
 * Each case pins `$HOME` to a fresh temp directory so the on-disk
 * write does not collide with the developer's real config.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getDefaultConfig,
  loadConfig,
  saveConfig,
  getConfigPath,
} from "../config.js";

function mkHome(): { home: string; restore: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fixo-direct-cfg-"));
  const originalHome = process.env.HOME;
  const originalFixoHome = process.env.FIXO_HOME;
  process.env.HOME = tmp;
  process.env.FIXO_HOME = tmp;
  return {
    home: tmp,
    restore: () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalFixoHome === undefined) delete process.env.FIXO_HOME;
      else process.env.FIXO_HOME = originalFixoHome;
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

test("getDefaultConfig — fresh install defaults to direct mode", () => {
  const cfg = getDefaultConfig();
  assert.equal(cfg.provider_mode, "direct");
  assert.equal(cfg._firstRunComplete, false);
  assert.equal(cfg.freellmapi_api_key, undefined);
  assert.equal(cfg.directProvider, undefined);
});

test("loadConfig — back-compat: pre-v1.1 config with FreeLLMAPI key is inferred as proxy", () => {
  const ctx = mkHome();
  try {
    const cfgDir = ctx.home;
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(cfgDir, "config.json"),
      JSON.stringify(
        {
          freellmapi_api_key: "freellmapi-user-sk-legacy",
          apiUrl: "https://freellm-for-fixo.vercel.app/v1",
          defaultModel: "auto",
          _firstRunComplete: true,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cfg = loadConfig();
    assert.equal(
      cfg.provider_mode,
      "proxy",
      "must NOT silently flip a working proxy user to direct",
    );
    assert.equal(cfg.freellmapi_api_key, "freellmapi-user-sk-legacy");
    assert.equal(cfg._firstRunComplete, true);
  } finally {
    ctx.restore();
  }
});

test("loadConfig — back-compat: pre-v1.1 config with no FreeLLMAPI key is inferred as direct", () => {
  const ctx = mkHome();
  try {
    const cfgDir = ctx.home;
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(cfgDir, "config.json"),
      JSON.stringify(
        {
          defaultModel: "auto",
          _firstRunComplete: true,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cfg = loadConfig();
    assert.equal(cfg.provider_mode, "direct");
    assert.equal(cfg.freellmapi_api_key, undefined);
  } finally {
    ctx.restore();
  }
});

test("loadConfig — explicit provider_mode field is always honored over inference", () => {
  const ctx = mkHome();
  try {
    const cfgDir = ctx.home;
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(cfgDir, "config.json"),
      JSON.stringify(
        {
          provider_mode: "direct",
          freellmapi_api_key: "freellmapi-user-sk-legacy",
          directProvider: { name: "openai", defaultModel: "gpt-4o" },
          defaultModel: "gpt-4o",
          _firstRunComplete: true,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cfg = loadConfig();
    assert.equal(cfg.provider_mode, "direct");
    assert.equal(cfg.directProvider?.name, "openai");
  } finally {
    ctx.restore();
  }
});

test("save then load — direct-mode config round-trips through disk", () => {
  const ctx = mkHome();
  try {
    const toSave = getDefaultConfig();
    toSave.provider_mode = "direct";
    toSave.directProvider = {
      name: "anthropic",
      defaultModel: "claude-opus-4-7",
    };
    toSave.defaultModel = "claude-opus-4-7";
    toSave._firstRunComplete = true;
    saveConfig(toSave);

    assert.ok(
      fs.existsSync(getConfigPath()),
      "config file should exist after save",
    );

    const loaded = loadConfig();
    assert.equal(loaded.provider_mode, "direct");
    assert.equal(loaded.directProvider?.name, "anthropic");
    assert.equal(loaded.directProvider?.defaultModel, "claude-opus-4-7");
    assert.equal(
      loaded.freellmapi_api_key,
      undefined,
      "direct mode should not persist a proxy key",
    );
  } finally {
    ctx.restore();
  }
});
