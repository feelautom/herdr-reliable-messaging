import { join } from "node:path";
import { readJson, writeJson } from "./storage.mjs";

/** Stable defaults written into the plugin's private configuration directory. */
export const DEFAULT_PLUGIN_CONFIG = Object.freeze({
  maxMessageUnits: 500,
  recipientConcurrency: 4,
  pendingAlertAgeMs: 300_000,
  pendingAlertCount: 25,
});

export const LEGACY_MESSAGE_UNITS = 300;
export const MIN_MESSAGE_UNITS = 64;
export const MAX_MESSAGE_UNITS = 4_000;
export const MIN_RECIPIENT_CONCURRENCY = 1;
export const MAX_RECIPIENT_CONCURRENCY = 16;

/** Smallest useful age threshold, preventing alert churn on normal scheduler ticks. */
export const MIN_PENDING_ALERT_AGE_MS = 10_000;

/** Largest accepted age threshold, bounding accidental monitoring disablement to seven days. */
export const MAX_PENDING_ALERT_AGE_MS = 604_800_000;

/** Smallest pending-count threshold accepted by the editable plugin configuration. */
export const MIN_PENDING_ALERT_COUNT = 1;

/** Largest pending-count threshold, aligned with the active queue capacity. */
export const MAX_PENDING_ALERT_COUNT = 1_000;

/** Returns the exact plugin-local settings path for display and diagnostics. */
export function pluginConfigPath(directory) {
  return join(directory, "settings.json");
}

/** Loads strict plugin-local settings and supplies alert defaults for legacy two-field files. */
export async function loadPluginConfig(directory) {
  const path = pluginConfigPath(directory);
  const stored = await readJson(path, undefined);
  if (stored === undefined) return { ...DEFAULT_PLUGIN_CONFIG };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw configError("PLUGIN_CONFIG_INVALID", "The plugin settings file must contain one JSON object.");
  }
  return {
    maxMessageUnits: boundedInteger(stored.maxMessageUnits, "maxMessageUnits", MIN_MESSAGE_UNITS, MAX_MESSAGE_UNITS),
    recipientConcurrency: boundedInteger(
      stored.recipientConcurrency,
      "recipientConcurrency",
      MIN_RECIPIENT_CONCURRENCY,
      MAX_RECIPIENT_CONCURRENCY,
    ),
    pendingAlertAgeMs: boundedInteger(
      stored.pendingAlertAgeMs ?? DEFAULT_PLUGIN_CONFIG.pendingAlertAgeMs,
      "pendingAlertAgeMs",
      MIN_PENDING_ALERT_AGE_MS,
      MAX_PENDING_ALERT_AGE_MS,
    ),
    pendingAlertCount: boundedInteger(
      stored.pendingAlertCount ?? DEFAULT_PLUGIN_CONFIG.pendingAlertCount,
      "pendingAlertCount",
      MIN_PENDING_ALERT_COUNT,
      MAX_PENDING_ALERT_COUNT,
    ),
  };
}

/** Creates the editable plugin-local settings file once and never overwrites it. */
export async function ensurePluginConfig(directory) {
  const path = pluginConfigPath(directory);
  const stored = await readJson(path, undefined);
  if (stored === undefined) await writeJson(path, DEFAULT_PLUGIN_CONFIG);
  return loadPluginConfig(directory);
}

/** Validates one persisted integer setting against its inclusive operational bounds. */
function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw configError("PLUGIN_CONFIG_INVALID", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

/** Creates one stable configuration failure without leaking the stored settings object. */
function configError(code, message) {
  return Object.assign(new Error(message), { code });
}
