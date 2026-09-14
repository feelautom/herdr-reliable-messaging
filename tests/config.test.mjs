import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PLUGIN_CONFIG,
  ensurePluginConfig,
  loadPluginConfig,
  pluginConfigPath,
} from "../src/config.mjs";

test("creates stable plugin-local defaults without environment overrides", async () => {
  await withDirectory(async (directory) => {
    assert.deepEqual(await loadPluginConfig(directory), DEFAULT_PLUGIN_CONFIG);
    assert.deepEqual(await ensurePluginConfig(directory), DEFAULT_PLUGIN_CONFIG);
    assert.deepEqual(JSON.parse(await readFile(pluginConfigPath(directory), "utf8")), DEFAULT_PLUGIN_CONFIG);
  });
});

// Legacy settings must acquire monitoring defaults without requiring an on-disk migration.
test("loads exact editable plugin-local settings", async () => {
  await withDirectory(async (directory) => {
    await writeFile(pluginConfigPath(directory), `${JSON.stringify({ maxMessageUnits: 700, recipientConcurrency: 3 })}\n`, "utf8");
    assert.deepEqual(await loadPluginConfig(directory), {
      maxMessageUnits: 700,
      recipientConcurrency: 3,
      pendingAlertAgeMs: DEFAULT_PLUGIN_CONFIG.pendingAlertAgeMs,
      pendingAlertCount: DEFAULT_PLUGIN_CONFIG.pendingAlertCount,
    });
  });
});

// Explicit operator thresholds must survive validation without unit conversion or normalization.
test("loads bounded pending-health alert thresholds", async () => {
  await withDirectory(async (directory) => {
    const settings = {
      maxMessageUnits: 700,
      recipientConcurrency: 3,
      pendingAlertAgeMs: 120_000,
      pendingAlertCount: 10,
    };
    await writeFile(pluginConfigPath(directory), `${JSON.stringify(settings)}\n`, "utf8");
    assert.deepEqual(await loadPluginConfig(directory), settings);
  });
});

// Every persisted setting remains fail-closed, including the new alert bounds.
test("rejects incomplete, non-integer, and out-of-range settings", async () => {
  await withDirectory(async (directory) => {
    for (const invalid of [
      {},
      { maxMessageUnits: "500", recipientConcurrency: 4 },
      { maxMessageUnits: 63, recipientConcurrency: 4 },
      { maxMessageUnits: 500, recipientConcurrency: 17 },
      { maxMessageUnits: 500, recipientConcurrency: 4, pendingAlertAgeMs: 9_999 },
      { maxMessageUnits: 500, recipientConcurrency: 4, pendingAlertCount: 1_001 },
    ]) {
      await writeFile(pluginConfigPath(directory), `${JSON.stringify(invalid)}\n`, "utf8");
      await assert.rejects(loadPluginConfig(directory), (error) => error.code === "PLUGIN_CONFIG_INVALID");
    }
  });
});

async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-config-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
