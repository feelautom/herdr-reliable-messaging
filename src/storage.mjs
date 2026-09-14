import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { PLUGIN_ID } from "./constants.mjs";

const execFileAsync = promisify(execFile);

/** Resolves plugin-owned state outside Git, with a repository-local development fallback. */
export async function resolveDataDirectory() {
  if (process.env.HERDR_RELIABLE_MESSAGING_DATA_DIR) return process.env.HERDR_RELIABLE_MESSAGING_DATA_DIR;
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR;
  try {
    const { stdout } = await execFileAsync(process.env.HERDR_BIN_PATH || "herdr", ["plugin", "config-dir", PLUGIN_ID], {
      windowsHide: true,
    });
    if (stdout.trim().length > 0) return stdout.trim();
  } catch {
    // Development and tests can run before the plugin is linked.
  }
  return join(process.cwd(), ".herdr-reliable-messaging");
}

/** Returns a stable lowercase SHA-256 fingerprint without changing the source string. */
export function fingerprint(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Reads one JSON document or a caller-provided fallback when it does not exist. */
export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

/** Atomically replaces one private state file. */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  let completed = false;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        completed = true;
        return;
      } catch (error) {
        if (error?.code !== "EPERM" || attempt >= 4) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally {
    if (!completed) await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Maps an opaque correlation identifier to a traversal-safe transaction path. */
export function transactionPath(directory, correlationId) {
  return join(directory, "transactions", `${fingerprint(correlationId)}.json`);
}

/**
 * Maps an exact batch correlation to its atomically published durable directory.
 * The SHA-256 name prevents traversal and hides the authored correlation from the path;
 * this pure mapping performs no existence check or filesystem mutation.
 */
export function batchDirectoryPath(directory, batchCorrelationId) {
  return join(directory, "transactions", "batches", fingerprint(batchCorrelationId));
}

/**
 * Returns the fixed body-free manifest path for one exact durable batch correlation.
 * It inherits traversal safety from `batchDirectoryPath` and performs no filesystem access.
 */
export function batchManifestPath(directory, batchCorrelationId) {
  return join(batchDirectoryPath(directory, batchCorrelationId), "manifest.json");
}

/**
 * Maps an exact child correlation to its hashed file inside one exact batch directory.
 * Both caller-controlled identifiers are path-safe projections; no lookup or mutation occurs.
 */
export function batchTransactionPath(directory, batchCorrelationId, correlationId) {
  return join(batchDirectoryPath(directory, batchCorrelationId), `${fingerprint(correlationId)}.json`);
}

/**
 * Maps one exact anomaly identity to a hashed JSON path in the separate control inbox.
 * The mapping prevents traversal and does not create, inspect, or mutate the inbox.
 */
export function alertPath(directory, alertId) {
  return join(directory, "alerts", `${fingerprint(alertId)}.json`);
}

/**
 * Lists body-free control-inbox records in deterministic path order.
 * A missing inbox is an empty result; other filesystem failures propagate without fallback.
 */
export async function listAlertPaths(directory) {
  const alertsDirectory = join(directory, "alerts");
  try {
    return (await readdir(alertsDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "variant" }))
      .map((name) => join(alertsDirectory, name));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Publishes a complete manifest and child set with one same-volume directory rename.
 *
 * All files are written privately before publication. Windows sharing violations receive four
 * bounded retries; any other failure removes only this call's staging directory and exposes no
 * partial batch to readers. An existing final directory is never replaced.
 */
export async function writeBatchAtomically(directory, batchCorrelationId, manifest, transactions) {
  const batchesDirectory = join(directory, "transactions", "batches");
  await mkdir(batchesDirectory, { recursive: true });
  const finalDirectory = batchDirectoryPath(directory, batchCorrelationId);
  const stagingDirectory = join(batchesDirectory, `.${fingerprint(batchCorrelationId)}.${randomUUID()}.tmp`);
  await mkdir(stagingDirectory);
  let completed = false;
  try {
    for (const transaction of transactions) {
      await writeJson(join(stagingDirectory, `${fingerprint(transaction.correlationId)}.json`), transaction);
    }
    await writeJson(join(stagingDirectory, "manifest.json"), manifest);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(stagingDirectory, finalDirectory);
        completed = true;
        break;
      } catch (error) {
        if (error?.code !== "EPERM" || attempt >= 4) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally {
    if (!completed) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Lists legacy and published batch-child transaction paths in deterministic order.
 * Manifests and staging directories are excluded, and a missing transaction root is empty.
 */
export async function listTransactionPaths(directory) {
  const transactionsDirectory = join(directory, "transactions");
  let entries;
  try {
    entries = await readdir(transactionsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(transactionsDirectory, entry.name));
  if (entries.some((entry) => entry.isDirectory() && entry.name === "batches")) {
    let batchEntries;
    try {
      batchEntries = await readdir(join(transactionsDirectory, "batches"), { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return paths;
      throw error;
    }
    for (const batchEntry of batchEntries) {
      if (!batchEntry.isDirectory() || batchEntry.name.endsWith(".tmp")) continue;
      const batchDirectory = join(transactionsDirectory, "batches", batchEntry.name);
      try {
        for (const child of await readdir(batchDirectory, { withFileTypes: true })) {
          if (child.isFile() && child.name.endsWith(".json") && child.name !== "manifest.json") {
            paths.push(join(batchDirectory, child.name));
          }
        }
      } catch (error) {
        // Retention may remove one complete terminal batch after the parent snapshot. Skipping
        // only that vanished directory preserves every other FIFO and capacity observation.
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return paths.sort((left, right) => left.localeCompare(right, "en", { sensitivity: "variant" }));
}

/**
 * Finds one exact correlation in legacy root storage or any published batch directory.
 * The direct legacy hash is checked first; batch records are then read because their parent
 * correlation is intentionally not derivable from a child correlation. Missing state is undefined.
 */
export async function findTransactionPath(directory, correlationId) {
  const direct = transactionPath(directory, correlationId);
  if (await readJson(direct, undefined)) return direct;
  for (const path of await listTransactionPaths(directory)) {
    const transaction = await readJson(path, undefined);
    if (transaction?.correlationId === correlationId) return path;
  }
  return undefined;
}

/**
 * Lists published batch manifests in deterministic path order without opening child bodies.
 * Staging directories are excluded and a missing batch root is treated as an empty list.
 */
export async function listBatchManifestPaths(directory) {
  const batchesDirectory = join(directory, "transactions", "batches");
  try {
    const paths = [];
    for (const entry of await readdir(batchesDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.endsWith(".tmp")) continue;
      paths.push(join(batchesDirectory, entry.name, "manifest.json"));
    }
    return paths.sort((left, right) => left.localeCompare(right, "en", { sensitivity: "variant" }));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** Returns active queue cardinality and retained body units without exposing content. */
export async function getPendingQueueUsage(directory) {
  let count = 0;
  let bodyUnits = 0;
  for (const path of await listTransactionPaths(directory)) {
    const transaction = await readJson(path, undefined);
    if (transaction?.status !== "PENDING") continue;
    count += 1;
    if (typeof transaction.body === "string") bodyUnits += transaction.body.length;
  }
  return { count, bodyUnits };
}

/**
 * Removes only abandoned task-private atomic-write artifacts older than a grace period.
 *
 * Root temporary files are unlinked individually and batch staging directories are removed as
 * units. Published batches and recent writers are never touched; unexpected filesystem failures
 * propagate so cleanup cannot silently hide storage damage.
 */
export async function cleanupTemporaryFiles(directory, options = {}) {
  const minimumAgeMs = options.minimumAgeMs ?? 60 * 60 * 1_000;
  const transactionsDirectory = join(directory, "transactions");
  let names;
  try {
    names = (await readdir(transactionsDirectory)).filter((name) => name.endsWith(".tmp"));
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const path = join(transactionsDirectory, name);
    try {
      if (Date.now() - (await stat(path)).mtimeMs < minimumAgeMs) continue;
      await unlink(path);
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const batchesDirectory = join(transactionsDirectory, "batches");
  try {
    for (const entry of await readdir(batchesDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".tmp")) continue;
      const path = join(batchesDirectory, entry.name);
      if (Date.now() - (await stat(path)).mtimeMs < minimumAgeMs) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return removed;
}

/**
 * Prunes terminal proofs by age and total retained child count without splitting batches.
 *
 * A batch is eligible only when every child is terminal. Newest groups are retained within both
 * the age window and count cap; deleting a batch removes its manifest and children together.
 * The returned count is the number of transaction proofs removed, not directory count.
 */
export async function pruneTerminalTransactions(directory, options = {}) {
  const retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1_000;
  const maximumTerminal = options.maximumTerminal ?? 1_000;
  const transactionsDirectory = join(directory, "transactions");
  const batchesDirectory = join(transactionsDirectory, "batches");
  const groups = new Map();
  for (const path of await listTransactionPaths(directory)) {
    const value = await readJson(path, undefined);
    const isBatch = dirname(dirname(path)) === batchesDirectory;
    const key = isBatch ? dirname(path) : path;
    const group = groups.get(key) || { key, isBatch, paths: [], terminal: true, updatedAt: 0 };
    group.paths.push(path);
    if (!value || !["DELIVERED", "FAILED", "CANCELED"].includes(value.status)) group.terminal = false;
    const updatedAt = Date.parse(value?.updatedAt || value?.createdAt || "");
    group.updatedAt = Math.max(group.updatedAt, Number.isFinite(updatedAt) ? updatedAt : 0);
    groups.set(key, group);
  }
  const terminal = [...groups.values()].filter((group) => group.terminal);
  terminal.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key, "en", { sensitivity: "variant" }));
  let removed = 0;
  let retained = 0;
  const now = Date.now();
  for (const group of terminal) {
    const keep = now - group.updatedAt <= retentionMs && retained + group.paths.length <= maximumTerminal;
    if (keep) {
      retained += group.paths.length;
      continue;
    }
    if (group.isBatch) await rm(group.key, { recursive: true, force: true });
    else await unlink(group.paths[0]);
    removed += group.paths.length;
  }
  return removed;
}

/** Acquires one short internal critical section for atomic plugin state mutation. */
export async function acquireStateLock(directory, stateIdentity, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 60_000;
  const lockPath = join(directory, "locks", fingerprint(stateIdentity));
  await mkdir(join(directory, "locks"), { recursive: true });
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), {
        encoding: "utf8",
        mode: 0o600,
      });
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockPath, now, now).catch(() => {});
      }, Math.max(1_000, Math.floor(staleMs / 3)));
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (inspectionError) {
        if (inspectionError?.code !== "ENOENT") throw inspectionError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw Object.assign(new Error("Another process is updating the same plugin state."), { code: "STATE_BUSY" });
      }
      await delay(50);
    }
  }
}

/** Appends a body-free diagnostic event and bounds the active file by size. */
export async function appendDiagnostic(directory, event, maximumBytes = 1_048_576) {
  const logs = join(directory, "logs");
  const active = join(logs, "events.jsonl");
  await mkdir(logs, { recursive: true });
  try {
    if ((await stat(active)).size >= maximumBytes) {
      await rm(`${active}.1`, { force: true });
      await rename(active, `${active}.1`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await appendFile(active, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
