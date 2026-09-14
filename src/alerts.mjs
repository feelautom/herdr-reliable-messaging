import { unlink } from "node:fs/promises";
import { serializeEnvelope, serializeLegacyEnvelope } from "./envelope.mjs";
import { advanceComposerMessage, initialComposerCheckpoint } from "./delivery.mjs";
import { verifyPinnedPane } from "./identity.mjs";
import { DEFAULT_PLUGIN_CONFIG } from "./config.mjs";
import {
  acquireStateLock,
  alertPath,
  findTransactionPath,
  fingerprint,
  listAlertPaths,
  listTransactionPaths,
  readJson,
  resolveDataDirectory,
  writeJson,
} from "./storage.mjs";

/** Visible non-pane source used for plugin-generated body-free operational notices. */
const CONTROL_SENDER_TITLE = "EXTERNAL HERDR RELIABLE MESSAGING";
/** Durable control-record version that introduced the compact bracketed envelope. */
const COMPACT_ALERT_VERSION = 2;
/** States that prevent any later control-channel composer interaction. */
const TERMINAL_ALERT_STATUSES = new Set(["DELIVERED", "FAILED", "CANCELED", "UNDELIVERABLE"]);
/** Maximum newest-first alert summaries returned by one read command. */
const DEFAULT_ALERT_LIMIT = 50;
/** Hard control-inbox record cap; source transaction receipts remain authoritative beyond it. */
const MAX_ALERT_RECORDS = 1_000;
/** One shared native-call budget per control scan, preventing alerts from starving data expiry. */
const MAX_ALERT_DRAIN_MS = 1_000;

/**
 * Creates one deduplicated body-free anomaly for every failed or over-age transaction.
 *
 * The records live outside the message FIFO. Pane senders can later receive a safe
 * composer notification; external senders retain a readable local-only result. Only
 * explicitly opted-in transactions are scanned, preventing an upgrade-time historical
 * burst. Per-alert locks make repeated scans idempotent; filesystem failures propagate.
 * Expiration notices preserve body-free unknown-reception and possible-fragment evidence;
 * alert capacity or delivery never participates in the data transaction's terminal write.
 */
export async function ensureDeliveryAnomalies(options = {}) {
  const directory = options.directory || await resolveDataDirectory();
  const currentTime = Number.isFinite(options.now) ? options.now : Date.now();
  const pendingAgeMs = options.pendingAgeMs ?? DEFAULT_PLUGIN_CONFIG.pendingAlertAgeMs;
  const maximumRecords = options.maximumRecords ?? MAX_ALERT_RECORDS;
  let recordCount = (await listAlertPaths(directory)).length;
  const created = [];
  for (const transactionFile of await listTransactionPaths(directory)) {
    const transaction = await readJson(transactionFile, undefined);
    if (!transaction) continue;
    // Records admitted before the control channel existed must not produce a historical
    // notification burst when a newer daemon first starts.
    if (transaction.alertPolicy !== "sender-notify-v1") continue;
    const ageMs = currentTime - Date.parse(transaction.createdAt || "");
    const isStuck = transaction.status === "PENDING" && Number.isFinite(ageMs) && ageMs >= pendingAgeMs;
    if (transaction.status !== "FAILED" && !isStuck) continue;
    const anomalyCode = isStuck ? "DELIVERY_STUCK" : transaction.code || "DELIVERY_FAILED";
    const alertId = `${transaction.correlationId}:${anomalyCode}`;
    const path = alertPath(directory, alertId);
    const release = await acquireStateLock(directory, `alert:${alertId}`, options.lockOptions);
    try {
      if (await readJson(path, undefined)) continue;
      // The data transaction remains the authoritative receipt when the best-effort control
      // inbox is full; refusing another record prevents a vanished sender from growing storage.
      if (recordCount >= maximumRecords) continue;
      const now = new Date(currentTime).toISOString();
      const deliverable = transaction.sender?.kind !== "external" && typeof transaction.sender?.paneId === "string";
      const alert = {
        version: COMPACT_ALERT_VERSION,
        alertId,
        correlationId: transaction.correlationId,
        ...(transaction.batchCorrelationId ? { batchCorrelationId: transaction.batchCorrelationId } : {}),
        queueSequence: transaction.queueSequence,
        createdAt: now,
        updatedAt: now,
        status: deliverable ? "PENDING" : "UNDELIVERABLE",
        code: deliverable ? "ANOMALY_QUEUED" : "EXTERNAL_SENDER_NO_RETURN_PANE",
        anomalyCode,
        sourceStatus: transaction.status,
        sourceCode: transaction.code,
        ...(transaction.expiredAt ? {
          previousCode: transaction.previousCode,
          receiptOutcome: transaction.receiptOutcome,
          composerState: transaction.composerState,
        } : {}),
        sender: transaction.sender,
        recipientTitle: transaction.recipient?.title,
        checkpoint: initialComposerCheckpoint(),
        nextAttemptAt: now,
      };
      await writeJson(path, alert);
      recordCount += 1;
      created.push(publicAlert(alert));
    } finally {
      await release();
    }
  }
  return created;
}

/**
 * Advances at most the oldest due control alert per sender without entering data FIFO lanes.
 * Independent sender lanes may progress in one poll. Future-due and terminal alerts are skipped;
 * composer/persistence failures propagate to the daemon's poll-level containment boundary.
 * All alert lanes share one wall-clock budget, including native subprocess timeouts. Exhaustion
 * leaves durable checkpoints retryable and returns control to the next data scan; it never replays
 * an ambiguous append or submission. `drainBudgetMs` may shorten the budget for isolated tests.
 */
export async function drainPendingAlerts(runner, options = {}) {
  const directory = options.directory || await resolveDataDirectory();
  const currentTime = Number.isFinite(options.now) ? options.now : Date.now();
  const budgetMs = Number.isInteger(options.drainBudgetMs) && options.drainBudgetMs > 0
    ? Math.min(options.drainBudgetMs, MAX_ALERT_DRAIN_MS) : MAX_ALERT_DRAIN_MS;
  const deadline = Date.now() + budgetMs;
  const boundedRunner = guardAlertDrain(runner, deadline);
  const pending = [];
  for (const path of await listAlertPaths(directory)) {
    const alert = await readJson(path, undefined);
    if (alert?.status !== "PENDING") continue;
    pending.push({ path, alert });
  }
  pending.sort((left, right) => (left.alert.createdAt || "").localeCompare(right.alert.createdAt || "") ||
    (left.alert.alertId || "").localeCompare(right.alert.alertId || ""));
  const laneHeads = new Map();
  for (const entry of pending) {
    const lane = entry.alert.sender?.paneId || entry.alert.sender?.title || entry.alert.alertId;
    if (!laneHeads.has(lane)) laneHeads.set(lane, entry);
  }
  const results = [];
  for (const entry of laneHeads.values()) {
    if (Date.now() >= deadline) break;
    if (Date.parse(entry.alert.nextAttemptAt || "") > currentTime) continue;
    results.push(await processAlertPath(boundedRunner, entry.path, { ...options, directory, now: currentTime }));
  }
  return results.filter(Boolean);
}

/**
 * Lists at most 50 newest body-free anomaly summaries for one exact pane sender or globally.
 * Sender-scoped reads require a real pane ID, while `all` explicitly supports external local
 * inspection. The operation never reads or returns a transaction body and performs no writes.
 */
export async function listDeliveryAlerts(operatorPaneId, options = {}) {
  if (options.all !== true && (typeof operatorPaneId !== "string" || operatorPaneId.length === 0)) {
    throw alertError("SOURCE_UNAVAILABLE", "Sender-scoped alerts require HERDR_PANE_ID; use --all for the global view.");
  }
  const directory = options.directory || await resolveDataDirectory();
  const alerts = [];
  for (const path of await listAlertPaths(directory)) {
    const alert = await readJson(path, undefined);
    if (!alert || (options.all !== true && alert.sender?.paneId !== operatorPaneId)) continue;
    alerts.push(publicAlert(alert));
  }
  alerts.sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || "") ||
    (right.alertId || "").localeCompare(left.alertId || ""));
  return alerts.slice(0, DEFAULT_ALERT_LIMIT);
}

/**
 * Prunes terminal control proofs by age and newest-first count while preserving active alerts.
 * Delivered, failed, canceled, and locally undeliverable records share one bounded retention
 * pool. Missing files during concurrent cleanup are ignored; other filesystem failures propagate.
 */
export async function pruneTerminalAlerts(directory, options = {}) {
  const retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1_000;
  const maximumTerminal = options.maximumTerminal ?? 1_000;
  const terminal = [];
  for (const path of await listAlertPaths(directory)) {
    const alert = await readJson(path, undefined);
    if (!alert || !TERMINAL_ALERT_STATUSES.has(alert.status)) continue;
    const updatedAt = Date.parse(alert.updatedAt || alert.createdAt || "");
    terminal.push({ path, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 });
  }
  terminal.sort((left, right) => right.updatedAt - left.updatedAt || left.path.localeCompare(right.path, "en", { sensitivity: "variant" }));
  let removed = 0;
  const now = Date.now();
  for (let index = 0; index < terminal.length; index += 1) {
    if (now - terminal[index].updatedAt <= retentionMs && index < maximumTerminal) continue;
    try {
      await unlink(terminal[index].path);
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

/**
 * Advances one persisted body-free alert through the verified composer state machine.
 * A recovered stuck source is canceled before display, an unavailable sender is rescheduled,
 * and definitive delivery/failure becomes terminal. The per-alert lock prevents concurrent sends.
 */
async function processAlertPath(runner, path, options) {
  const directory = options.directory;
  let alert = await readJson(path, undefined);
  if (!alert || TERMINAL_ALERT_STATUSES.has(alert.status)) return alert ? publicAlert(alert) : undefined;
  const release = await acquireStateLock(directory, `alert:${alert.alertId}`, options.lockOptions);
  try {
    alert = await readJson(path, undefined);
    if (!alert || TERMINAL_ALERT_STATUSES.has(alert.status)) return alert ? publicAlert(alert) : undefined;
    if (alert.anomalyCode === "DELIVERY_STUCK") {
      const sourcePath = await findTransactionPath(directory, alert.correlationId);
      const source = sourcePath ? await readJson(sourcePath, undefined) : undefined;
      if (!source || source.status !== "PENDING") {
        alert = terminalizeAlert(alert, "CANCELED", "ANOMALY_RECOVERED_BEFORE_NOTICE");
        await writeJson(path, alert);
        return publicAlert(alert);
      }
    }
    if (!await verifyPinnedPane(runner, alert.sender)) {
      alert = scheduleAlert(alert, "SENDER_UNAVAILABLE", options.now);
      await writeJson(path, alert);
      return publicAlert(alert);
    }
    const message = alertMessage(alert);
    let payload;
    if (alert.version === 1) payload = serializeLegacyEnvelope(CONTROL_SENDER_TITLE, alert.sender.title, message);
    else if (alert.version === COMPACT_ALERT_VERSION) payload = serializeEnvelope(CONTROL_SENDER_TITLE, alert.sender.title, message);
    else {
      alert = terminalizeAlert(alert, "FAILED", "UNSUPPORTED_ALERT_VERSION");
      await writeJson(path, alert);
      return publicAlert(alert);
    }
    const envelopeLimit = options.envelopeLimit ?? DEFAULT_PLUGIN_CONFIG.maxMessageUnits;
    const persist = async (checkpoint) => {
      alert.checkpoint = checkpoint;
      alert.updatedAt = new Date(options.now).toISOString();
      await writeJson(path, alert);
    };
    const outcome = await advanceComposerMessage(
      runner,
      alert.sender.paneId,
      payload,
      envelopeLimit,
      alert.checkpoint,
      persist,
      async () => {},
      { now: options.now },
    );
    alert.checkpoint = outcome.checkpoint;
    alert.updatedAt = new Date(options.now).toISOString();
    if (outcome.status === "DELIVERED") alert = terminalizeAlert(alert, "DELIVERED", "ANOMALY_DELIVERY_CONFIRMED");
    else if (outcome.status === "FAILED") alert = terminalizeAlert(alert, "FAILED", outcome.code);
    else alert = scheduleAlert(alert, outcome.code, options.now, 200);
    await writeJson(path, alert);
    return publicAlert(alert);
  } catch (error) {
    if (error?.code !== "ALERT_DRAIN_DEADLINE_REACHED") throw error;
    // persist() has already retained any write intent. A budget timeout must not clear
    // that checkpoint or claim that an issued native command had no effect.
    alert = scheduleAlert(alert, "ANOMALY_OBSERVATION_TIMEOUT", options.now);
    await writeJson(path, alert);
    return publicAlert(alert);
  } finally {
    await release();
  }
}

/**
 * Bounds every native control-channel call by the same scan deadline, even on rejection.
 * The production runner terminates its timed-out CLI process; an already-issued native effect
 * remains ambiguous. No Promise.race abandons a live writer while releasing its transaction lock.
 */
function guardAlertDrain(runner, deadline) {
  /** Produces only the remaining budget, or stops before another native operation can start. */
  const remaining = () => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw alertError("ALERT_DRAIN_DEADLINE_REACHED", "The control scan budget elapsed.");
    return { timeoutMs };
  };
  return {
    /** Bounds target resolution and composer writes without losing the runner's receiver. */
    async run(args) {
      const budget = remaining();
      try { return await runner.run(args, budget); }
      finally { remaining(); }
    },
    /** Bounds snapshots and deeper history while preserving ambiguous checkpoint recovery. */
    async runText(args) {
      const budget = remaining();
      try { return await runner.runText(args, budget); }
      finally { remaining(); }
    },
  };
}

/**
 * Produces one single-line control message exclusively from body-free transaction metadata.
 * Exact correlation and destination values are preserved for operator lookup; source bodies are
 * neither loaded nor interpolated.
 */
function alertMessage(alert) {
  const expirationDetail = alert.sourceCode === "DELIVERY_EXPIRED"
    ? ` Expired after five minutes; ${alert.receiptOutcome === "UNKNOWN" ? "receipt outcome unknown after submission" : "delivery not confirmed"}. No automatic replay.${alert.composerState === "POSSIBLE_ORPHAN_PRESERVED" ? " Possible composer fragment preserved." : ""}`
    : "";
  return `Delivery problem for ${alert.correlationId} to ${alert.recipientTitle}: ${alert.anomalyCode} (${alert.sourceCode || "UNKNOWN"}).${expirationDetail} Check alerts or queue status.`;
}

/**
 * Returns a pending retry snapshot with a bounded future observation time.
 * The anomaly identity and composer checkpoint remain unchanged; callers persist the result.
 */
function scheduleAlert(alert, code, now, delayMs = 1_000) {
  return {
    ...alert,
    status: "PENDING",
    code,
    updatedAt: new Date(now).toISOString(),
    nextAttemptAt: new Date(now + delayMs).toISOString(),
  };
}

/**
 * Returns a terminal body-free alert proof and removes its retry deadline.
 * The caller owns persistence; the original anomaly identity and checkpoint are preserved.
 */
function terminalizeAlert(alert, status, code) {
  const terminal = { ...alert, status, code, updatedAt: new Date().toISOString() };
  delete terminal.nextAttemptAt;
  return terminal;
}

/**
 * Projects the approved body-free control-inbox fields for CLI and daemon results.
 * Persisted sender pins and composer checkpoints are intentionally omitted.
 */
function publicAlert(alert) {
  return {
    alertId: alert.alertId,
    correlationId: alert.correlationId,
    ...(alert.batchCorrelationId ? { batchCorrelationId: alert.batchCorrelationId } : {}),
    queueSequence: alert.queueSequence,
    createdAt: alert.createdAt,
    updatedAt: alert.updatedAt,
    status: alert.status,
    code: alert.code,
    anomalyCode: alert.anomalyCode,
    sourceStatus: alert.sourceStatus,
    sourceCode: alert.sourceCode,
    ...(alert.receiptOutcome ? {
      previousCode: alert.previousCode,
      receiptOutcome: alert.receiptOutcome,
      composerState: alert.composerState,
    } : {}),
    senderTitle: alert.sender?.title,
    recipientTitle: alert.recipientTitle,
  };
}

/**
 * Creates one stable control-channel error from a caller-approved code and message.
 * It performs no persistence or logging and never receives transaction bodies.
 */
function alertError(code, message) {
  return Object.assign(new Error(message), { code });
}
