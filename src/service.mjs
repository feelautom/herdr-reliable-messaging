import { randomUUID } from "node:crypto";
import { DEFAULT_PLUGIN_CONFIG } from "./config.mjs";
import {
  COMPACT_ENVELOPE_TRANSACTION_VERSION,
  createComposerChunks,
  serializeEnvelope,
  serializeTransactionEnvelope,
} from "./envelope.mjs";
import { advanceComposerMessage, initialComposerCheckpoint } from "./delivery.mjs";
import { isValidPaneTitle, pinPane, resolveBatchEndpoints, resolveMessageSender, resolveRecipientByTitle, sameSenderIdentity, verifyPinnedPane } from "./identity.mjs";
import {
  MAX_PENDING_BODY_UNITS,
  MAX_PENDING_TRANSACTIONS,
  MAX_PENDING_AGE_MS,
  OBSERVATION_DELAY_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from "./constants.mjs";
import {
  acquireStateLock,
  appendDiagnostic,
  batchManifestPath,
  batchTransactionPath,
  cleanupTemporaryFiles,
  findTransactionPath,
  fingerprint,
  getPendingQueueUsage,
  listBatchManifestPaths,
  listTransactionPaths,
  pruneTerminalTransactions,
  readJson,
  resolveDataDirectory,
  transactionPath,
  writeBatchAtomically,
  writeJson,
} from "./storage.mjs";

const TERMINAL_STATUSES = new Set(["DELIVERED", "FAILED", "CANCELED"]);
const DEFAULT_RECEIPT_LIMIT = 50;
/** Maximum atomic fan-out, bounding retained bodies, validation work, and aggregate output. */
const MAX_BATCH_RECIPIENTS = 50;

/**
 * Accepts one exact message durably from any Herdr pane or explicit external caller.
 *
 * The sender mechanism must be unambiguous, the recipient must be an exact single-line
 * pane title, and the body remains normalization-free. The function atomically owns the
 * body before returning `ACCEPTED`; capacity, identity, or correlation conflicts fail
 * before a new transaction is admitted. New records opt into body-free deferred anomaly
 * feedback. A missing target may remain pending, but a duplicate live title returns exact
 * correction candidates instead of poisoning a FIFO lane. All later progression belongs
 * to the daemon, and every durable correlation kind shares one namespace.
 */
export async function enqueueReliableMessage(runner, input, options = {}) {
  const correlationId = input.correlationId || randomUUID();
  validateCorrelationId(correlationId);
  if (!isValidPaneTitle(input.recipientTitle)) {
    throw serviceError("TARGET_INVALID", "The recipient must be an exact single-line pane title.");
  }
  const sender = await resolveMessageSender(runner, {
    paneId: input.senderPaneId,
    externalLabel: input.externalSenderLabel,
  });
  const directory = options.directory || await resolveDataDirectory();
  if (sender.kind === "pane" && sender.title === input.recipientTitle) {
    return discardSelfMessage(directory, correlationId, sender, input.recipientTitle, input.body);
  }
  const envelopeLimit = options.config?.maxMessageUnits ?? DEFAULT_PLUGIN_CONFIG.maxMessageUnits;
  const payload = serializeEnvelope(sender.title, input.recipientTitle, input.body);
  const chunks = createComposerChunks(payload, envelopeLimit);
  await Promise.all([pruneTerminalTransactions(directory, options.retentionOptions), cleanupTemporaryFiles(directory)]);
  const path = transactionPath(directory, correlationId);
  const messageHash = fingerprint(input.body);
  const payloadHash = fingerprint(payload);
  const chunkHashes = chunks.map((chunk) => fingerprint(chunk));
  const admissionRelease = await acquireStateLock(directory, "queue:admission", options.lockOptions);
  try {
    if (await readJson(batchManifestPath(directory, correlationId), undefined)) {
      throw serviceError("CORRELATION_CONFLICT", "The correlation identifier already belongs to a batch.");
    }
    const existingPath = await findTransactionPath(directory, correlationId);
    const existing = existingPath ? await readJson(existingPath, undefined) : undefined;
    if (existing) {
      if (existing.batchCorrelationId) {
        throw serviceError("CORRELATION_CONFLICT", "The correlation identifier already belongs to a batch child.");
      }
      assertMatchingTransaction(existing, correlationId, sender, input.recipientTitle, input.body, messageHash, envelopeLimit);
      return publicResult(existing, TERMINAL_STATUSES.has(existing.status) ? existing.status : "ACCEPTED", "ALREADY_ACCEPTED");
    }
    const usage = await getPendingQueueUsage(directory);
    if (usage.count >= MAX_PENDING_TRANSACTIONS || usage.bodyUnits + input.body.length > MAX_PENDING_BODY_UNITS) {
      throw serviceError("QUEUE_CAPACITY_EXCEEDED", "The durable delivery queue has reached its configured capacity.");
    }
    let recipient = { title: input.recipientTitle };
    try {
      const resolved = await resolveRecipientByTitle(runner, input.recipientTitle);
      if (sender.kind === "pane" && resolved.pane_id === sender.paneId) {
        return discardSelfMessage(directory, correlationId, sender, input.recipientTitle, input.body);
      }
      recipient = pinPane(resolved);
    } catch (error) {
      if (!isTransientTargetError(error)) throw error;
    }
    const now = new Date().toISOString();
    const queueSequence = await nextQueueSequence(directory);
    const transaction = {
      version: COMPACT_ENVELOPE_TRANSACTION_VERSION,
      correlationId,
      queueSequence,
      createdAt: now,
      updatedAt: now,
      status: "PENDING",
      code: "QUEUED_FOR_DELIVERY",
      alertPolicy: "sender-notify-v1",
      sender,
      recipient,
      body: input.body,
      messageHash,
      messageLength: input.body.length,
      payloadHash,
      payloadLength: payload.length,
      envelopeLimit,
      chunkHashes,
      chunkLengths: chunks.map((chunk) => chunk.length),
      checkpoint: initialComposerCheckpoint(),
      retryCount: 0,
      nextAttemptAt: now,
    };
    await writeJson(path, transaction);
    await appendDiagnostic(directory, diagnostic(transaction, "queue", "accepted"));
    return publicResult(transaction, "ACCEPTED", "QUEUED_FOR_DELIVERY");
  } finally {
    await admissionRelease();
  }
}

/**
 * Atomically admits one exact body for several independently delivered destinations.
 *
 * Batch-only target validation is strict and uses one fresh pane inventory. Every child
 * owns a durable transaction, FIFO sequence, checkpoint, and terminal body scrub while
 * the body-free manifest provides stable aggregate identity and idempotent replay. The
 * complete batch is rejected on capacity or identity failure; after atomic publication,
 * optional diagnostics cannot turn durable acceptance into an ambiguous caller failure.
 */
export async function enqueueReliableBatch(runner, input, options = {}) {
  const batchCorrelationId = input.batchCorrelationId || randomUUID();
  validateCorrelationId(batchCorrelationId);
  const titles = input.recipientTitles;
  if (!Array.isArray(titles) || titles.length < 2 || titles.length > MAX_BATCH_RECIPIENTS) {
    throw serviceError("INVALID_BATCH", `A batch requires 2-${MAX_BATCH_RECIPIENTS} exact recipient titles.`);
  }
  const seen = new Set();
  for (const title of titles) {
    if (!isValidPaneTitle(title)) throw serviceError("TARGET_INVALID", "Every batch recipient must be an exact single-line pane title.");
    if (seen.has(title)) throw serviceError("DUPLICATE_TARGET", "A batch cannot contain the same exact recipient title more than once.", { title });
    seen.add(title);
  }
  const directory = options.directory || await resolveDataDirectory();
  const envelopeLimit = options.config?.maxMessageUnits ?? DEFAULT_PLUGIN_CONFIG.maxMessageUnits;
  // Reuse the envelope validator without changing or persisting the authored body.
  serializeEnvelope("BATCH VALIDATION", "BATCH VALIDATION", input.body);
  const messageHash = fingerprint(input.body);
  const admissionRelease = await acquireStateLock(directory, "queue:admission", options.lockOptions);
  try {
    const existing = await readJson(batchManifestPath(directory, batchCorrelationId), undefined);
    const namespaceTransaction = await findTransactionPath(directory, batchCorrelationId);
    if (existing && namespaceTransaction) {
      throw serviceError("BATCH_CORRELATION_CONFLICT", "The batch correlation ambiguously belongs to both batch and transaction state.");
    }
    if (existing) {
      const sender = await resolveMessageSender(runner, {
        paneId: input.senderPaneId,
        externalLabel: input.externalSenderLabel,
      });
      assertMatchingBatch(existing, batchCorrelationId, sender, titles, messageHash, envelopeLimit);
      return { ...(await showReliableBatch(batchCorrelationId, { directory })), status: "ACCEPTED", code: "ALREADY_ACCEPTED" };
    }
    if (namespaceTransaction) {
      throw serviceError("BATCH_CORRELATION_CONFLICT", "The batch correlation already belongs to a transaction.");
    }
    const { sender, recipients } = await resolveBatchEndpoints(runner, {
      paneId: input.senderPaneId,
      externalLabel: input.externalSenderLabel,
      recipientTitles: titles,
    });
    await Promise.all([pruneTerminalTransactions(directory, options.retentionOptions), cleanupTemporaryFiles(directory)]);
    const usage = await getPendingQueueUsage(directory);
    if (usage.count + titles.length > MAX_PENDING_TRANSACTIONS ||
        usage.bodyUnits + input.body.length * titles.length > MAX_PENDING_BODY_UNITS) {
      throw serviceError("QUEUE_CAPACITY_EXCEEDED", "The durable delivery queue cannot admit the complete batch.");
    }
    const now = new Date().toISOString();
    const firstQueueSequence = await nextQueueSequence(directory);
    const childCorrelationIds = titles.map((title, index) => childCorrelationId(batchCorrelationId, title, index));
    if (new Set(childCorrelationIds).size !== childCorrelationIds.length || childCorrelationIds.includes(batchCorrelationId)) {
      throw serviceError("BATCH_CHILD_CORRELATION_CONFLICT", "The derived batch child correlations are not unique.");
    }
    for (const correlationId of childCorrelationIds) {
      if (await findTransactionPath(directory, correlationId) ||
          await readJson(batchManifestPath(directory, correlationId), undefined)) {
        throw serviceError("BATCH_CHILD_CORRELATION_CONFLICT", "A derived batch child correlation already belongs to durable state.");
      }
    }
    const transactions = recipients.map((recipient, index) => createBatchTransaction({
      batchCorrelationId,
      correlationId: childCorrelationIds[index],
      queueSequence: firstQueueSequence + index,
      now,
      sender,
      recipient: pinPane(recipient),
      body: input.body,
      envelopeLimit,
    }));
    const manifest = {
      version: 1,
      batchCorrelationId,
      createdAt: now,
      sender,
      recipientTitles: [...titles],
      messageHash,
      messageLength: input.body.length,
      envelopeLimit,
      childCorrelationIds: transactions.map(({ correlationId }) => correlationId),
    };
    await writeBatchAtomically(directory, batchCorrelationId, manifest, transactions);
    // Durable publication is the acceptance boundary; diagnostics must not make callers retry
    // an already-owned batch if the optional operational log is temporarily unavailable.
    await Promise.allSettled(transactions.map((transaction) => appendDiagnostic(directory, diagnostic(transaction, "batch_queue", "accepted"))));
    return batchResult(manifest, transactions, "ACCEPTED", "BATCH_QUEUED_FOR_DELIVERY");
  } finally {
    await admissionRelease();
  }
}

/**
 * Returns one body-free aggregate snapshot for an exact durable batch correlation.
 * The manifest fixes child order; any missing child fails closed as `BATCH_INCOMPLETE`
 * instead of presenting a misleading partial aggregate. This read performs no writes.
 */
export async function showReliableBatch(batchCorrelationId, options = {}) {
  validateCorrelationId(batchCorrelationId);
  const directory = options.directory || await resolveDataDirectory();
  const manifest = await readJson(batchManifestPath(directory, batchCorrelationId), undefined);
  if (!manifest) throw serviceError("BATCH_NOT_FOUND", "The requested batch does not exist.");
  const transactions = [];
  for (const correlationId of manifest.childCorrelationIds || []) {
    const transaction = await readJson(batchTransactionPath(directory, batchCorrelationId, correlationId), undefined);
    if (!transaction) throw serviceError("BATCH_INCOMPLETE", "A durable batch child is missing.");
    transactions.push(transaction);
  }
  return batchResult(manifest, transactions);
}

/**
 * Lists at most 50 newest body-free batch aggregates for one exact pane sender or globally.
 * Sender-scoped reads require `HERDR_PANE_ID`; `all` is an explicit local inspection mode.
 * Corrupt/incomplete batches propagate their failure rather than disappearing from history.
 */
export async function listReliableBatches(operatorPaneId, options = {}) {
  if (options.all !== true && (typeof operatorPaneId !== "string" || operatorPaneId.length === 0)) {
    throw serviceError("SOURCE_UNAVAILABLE", "Sender-scoped batch receipts require HERDR_PANE_ID; use --all for the global view.");
  }
  const directory = options.directory || await resolveDataDirectory();
  const batches = [];
  for (const path of await listBatchManifestPaths(directory)) {
    const manifest = await readJson(path, undefined);
    if (!manifest || (options.all !== true && manifest.sender?.paneId !== operatorPaneId)) continue;
    batches.push(await showReliableBatch(manifest.batchCorrelationId, { directory }));
  }
  batches.sort((left, right) => compareOrdinal(right.createdAt || "", left.createdAt || "") ||
    compareOrdinal(right.batchCorrelationId || "", left.batchCorrelationId || ""));
  return batches.slice(0, DEFAULT_RECEIPT_LIMIT);
}

/** Drops one self-addressed pane message without creating retryable queue state. */
async function discardSelfMessage(directory, correlationId, sender, recipientTitle, body) {
  const result = {
    correlationId,
    status: "DISCARDED",
    code: "SELF_MESSAGE_DISCARDED",
    senderTitle: sender.title,
    recipientTitle,
    messageLength: typeof body === "string" ? body.length : 0,
  };
  await appendDiagnostic(directory, {
    correlationId,
    senderTitle: sender.title,
    recipientTitle,
    messageLength: result.messageLength,
    stage: "queue",
    outcome: "discarded",
    status: result.status,
    code: result.code,
  });
  return result;
}

/**
 * Advances one durable transaction as far as current Herdr evidence safely permits.
 *
 * The single daemon validates the persisted exact body and advances at most one loading
 * or submission action. Composer fragments are internal writes, never visible messages;
 * the complete envelope is submitted once. Recoverable uncertainty is persisted with a
 * deadline for a later scan rather than blocking another destination or duplicating text.
 * A terminal delivery-machine failure is atomically scrubbed before its FIFO follower may run.
 * Every pending record expires at its original admission deadline, before retry
 * scheduling or Herdr access. The lock protects the reread and terminal scrub from cancel
 * and other workers. Expiration never clears a composer or asserts non-reception.
 * `clock` supplies a live test clock; `now` freezes time for existing deterministic callers.
 * `expirationOnly` performs no delivery when a scheduler candidate is still fresh.
 */
export async function processTransactionPath(runner, path, options = {}) {
  const directory = options.directory || await resolveDataDirectory();
  let transaction = await readJson(path, undefined);
  if (!transaction) return undefined;
  if (TERMINAL_STATUSES.has(transaction.status)) return publicResult(transaction, transaction.status, transaction.code);
  const release = await acquireStateLock(
    directory,
    `transaction:${transaction.correlationId || path}`,
    options.lockOptions,
  );
  try {
    transaction = await readJson(path, undefined);
    if (!transaction) return undefined;
    if (TERMINAL_STATUSES.has(transaction.status)) {
      return publicResult(transaction, transaction.status, transaction.code);
    }
    const currentTime = transactionTime(options);
    if (pendingExpired(transaction, currentTime)) {
      return await persistExpiration(path, transaction, currentTime);
    }
    if (options.expirationOnly === true) return publicResult(transaction, transaction.status, transaction.code);
    if (typeof transaction.nextAttemptAt === "string" && Date.parse(transaction.nextAttemptAt) > currentTime) {
      return publicResult(transaction, "PENDING", "RETRY_NOT_DUE");
    }
    if (![4, COMPACT_ENVELOPE_TRANSACTION_VERSION].includes(transaction.version) || typeof transaction.body !== "string") {
      transaction = terminalize(transaction, "FAILED", "LEGACY_PENDING_UNRESUMABLE");
      await writeJson(path, transaction);
      return publicResult(transaction, transaction.status, transaction.code);
    }
    let payload;
    let chunks;
    try {
      payload = serializeTransactionEnvelope(
        transaction.version,
        transaction.sender.title,
        transaction.recipient.title,
        transaction.body,
      );
      chunks = createComposerChunks(payload, transaction.envelopeLimit);
      assertStoredPayload(transaction, payload, chunks);
    } catch (error) {
      transaction = terminalize(transaction, "FAILED", typeof error?.code === "string" ? error.code : "STORED_MESSAGE_INVALID");
      await writeJson(path, transaction);
      return publicResult(transaction, transaction.status, transaction.code);
    }

    const deadlineRunner = guardTransactionDeadline(runner, transaction, options);
    const targetResolution = await ensureRecipientPin(deadlineRunner, transaction);
    if (!targetResolution.ready) {
      transaction = targetResolution.terminal
        ? terminalize(transaction, "FAILED", targetResolution.code)
        : scheduleRetry(transaction, targetResolution.code, currentTime);
      await writeJson(path, transaction);
      await appendDiagnostic(directory, diagnostic(transaction, "target_resolution", targetResolution.terminal ? "failed" : "waiting"));
      return publicResult(transaction, transaction.status, transaction.code);
    }
    transaction = targetResolution.transaction;
    await writeJson(path, transaction);

    const trace = async (event) => appendDiagnostic(directory, {
      correlationId: transaction.correlationId,
      queueSequence: transaction.queueSequence,
      totalChunks: chunks.length,
      payloadLength: payload.length,
      payloadHash: transaction.payloadHash,
      senderTitle: transaction.sender.title,
      recipientTitle: transaction.recipient.title,
      ...event,
    });
    const persist = async (checkpoint) => {
      transaction.checkpoint = checkpoint;
      transaction.updatedAt = new Date().toISOString();
      await writeJson(path, transaction);
    };
    const outcome = await advanceComposerMessage(
      deadlineRunner,
      transaction.recipient.paneId,
      payload,
      transaction.envelopeLimit,
      transaction.checkpoint,
      persist,
      trace,
      { now: currentTime },
    );
    transaction.checkpoint = outcome.checkpoint;
    // Delivery catches transport exceptions as observations. Recheck time even when it
    // swallowed the deadline signal; no late evidence may turn expiration into DELIVERED.
    if (pendingExpired(transaction, transactionTime(options))) {
      return await persistExpiration(path, transaction, transactionTime(options));
    }
    transaction.updatedAt = new Date().toISOString();
    transaction.code = outcome.code;
    if (outcome.status === "DELIVERED") {
      transaction = terminalize(transaction, "DELIVERED", "DELIVERY_CONFIRMED");
    } else if (outcome.status === "FAILED") {
      transaction = terminalize(transaction, "FAILED", outcome.code);
    } else {
      transaction = scheduleObservation(transaction, outcome.code, currentTime);
    }
    transaction.retryCount = 0;
    await writeJson(path, transaction);
    return publicResult(transaction, transaction.status, transaction.code);
  } catch (error) {
    if (error?.code !== "DELIVERY_DEADLINE_REACHED") throw error;
    return await persistExpiration(path, transaction, transactionTime(options));
  } finally {
    await release();
  }
}

/**
 * Expires all stale data entries before choosing fresh FIFO heads, including queued followers.
 * The transaction lock revalidates each candidate; a failed expiration keeps its lane blocked.
 * Independent heads remain bounded by recipientConcurrency. Restart uses original disk dates.
 */
export async function drainPendingTransactions(runner, options = {}) {
  const directory = options.directory || await resolveDataDirectory();
  const currentTime = transactionTime(options);
  const pending = [];
  for (const path of await listTransactionPaths(directory)) {
    const transaction = await readJson(path, undefined);
    if (transaction?.status !== "PENDING") continue;
    pending.push({
      path,
      queueSequence: transaction.queueSequence,
      createdAt: transaction.createdAt || "",
      correlationId: transaction.correlationId || "",
      recipientTitle: transaction.recipient?.title || `transaction:${transaction.correlationId || path}`,
      nextAttemptAt: transaction.nextAttemptAt,
    });
  }
  pending.sort(compareQueueEntries);

  const results = [];
  const remaining = [];
  for (const entry of pending) {
    if (pendingExpired(entry, transactionTime(options))) {
      try {
        const result = await processTransactionPath(runner, entry.path, { ...options, directory, expirationOnly: true });
        if (!result) continue;
        if (TERMINAL_STATUSES.has(result.status)) { results.push(result); continue; }
      } catch (error) {
        await appendDiagnostic(directory, { correlationId: entry.correlationId, stage: "expiration", outcome: "failed", errorCode: error?.code || "UNEXPECTED_ERROR" });
      }
    }
    remaining.push(entry);
  }

  // Each destination behaves like one independently timed Arduino task: its oldest
  // message remains the only eligible entry while other destination heads may advance.
  const laneHeads = new Map();
  for (const entry of remaining) {
    if (!laneHeads.has(entry.recipientTitle)) laneHeads.set(entry.recipientTitle, entry);
  }
  const due = [...laneHeads.values()].filter((entry) => (
    typeof entry.nextAttemptAt !== "string" || Date.parse(entry.nextAttemptAt) <= currentTime
  ));

  const processEntry = async (entry) => {
    try {
      return await processTransactionPath(runner, entry.path, options);
    } catch (error) {
      await appendDiagnostic(directory, {
        correlationId: entry.correlationId,
        stage: "daemon_drain",
        outcome: "failed",
        errorCode: typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR",
      });
      return undefined;
    }
  };
  const concurrency = options.recipientConcurrency ?? DEFAULT_PLUGIN_CONFIG.recipientConcurrency;
  for (let index = 0; index < due.length; index += concurrency) {
    results.push(...await Promise.all(due.slice(index, index + concurrency).map(processEntry)));
  }
  return results.filter(Boolean);
}

/**
 * Lists queue metadata for any local plugin caller without returning message bodies.
 * The runner and operator arguments remain accepted for API compatibility but confer no
 * role-based authority; local filesystem access is the queue-management trust boundary.
 */
export async function listQueueEntries(runner, operatorPaneId, options = {}) {
  const directory = options.directory || await resolveDataDirectory();
  const entries = [];
  for (const path of await listTransactionPaths(directory)) {
    const transaction = await readJson(path, undefined);
    if (!transaction || (!options.includeTerminal && transaction.status !== "PENDING")) continue;
    entries.push(queueSummary(transaction));
  }
  return entries.sort(compareQueueEntries);
}

/**
 * Lists recent body-free delivery outcomes without adding writes to message delivery.
 *
 * The default view selects records whose persisted pane ID exactly matches the current
 * caller. The global view is available to local operators with `all: true`. Both views
 * derive their result from existing durable transactions, order newest first, and cap
 * output at 50 records.
 */
export async function listDeliveryReceipts(runner, operatorPaneId, options = {}) {
  if (options.all !== true && (typeof operatorPaneId !== "string" || operatorPaneId.length === 0)) {
    throw serviceError("SOURCE_UNAVAILABLE", "Sender-scoped receipts require HERDR_PANE_ID; use --all for the global view.");
  }
  const directory = options.directory || await resolveDataDirectory();
  const receipts = [];
  for (const path of await listTransactionPaths(directory)) {
    const transaction = await readJson(path, undefined);
    if (!transaction || (options.all !== true && transaction.sender?.paneId !== operatorPaneId)) continue;
    receipts.push({
      ...queueSummary(transaction),
      senderPaneId: transaction.sender?.paneId,
      detail: receiptDetail(transaction.status, transaction.code, transaction.receiptOutcome, transaction.composerState),
    });
  }
  receipts.sort((left, right) => compareQueueEntries(right, left));
  return receipts.slice(0, DEFAULT_RECEIPT_LIMIT);
}

/**
 * Returns one exact legacy or batch-child queue record to a local caller by correlation.
 * The body is included only while still retained by an active transaction. The runner and
 * operator arguments remain compatibility parameters and do not classify the caller.
 */
export async function showQueueEntry(runner, operatorPaneId, correlationId, options = {}) {
  validateCorrelationId(correlationId);
  const directory = options.directory || await resolveDataDirectory();
  const path = await findTransactionPath(directory, correlationId);
  const transaction = path ? await readJson(path, undefined) : undefined;
  if (!transaction) throw serviceError("QUEUE_ENTRY_NOT_FOUND", "The requested queue entry does not exist.");
  return { ...queueSummary(transaction), ...(typeof transaction.body === "string" ? { body: transaction.body } : {}) };
}

/**
 * Wakes one pending entry without changing any injection checkpoint.
 * Terminal records remain unchanged, and an unknown or invalid correlation fails without
 * creating state. Caller role is intentionally irrelevant at this local trust boundary.
 */
export async function retryQueueEntry(runner, operatorPaneId, correlationId, options = {}) {
  return mutateQueueEntry(correlationId, options, (transaction) => transaction.status === "PENDING"
    ? { ...transaction, code: "MANUAL_WAKE", nextAttemptAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    : transaction);
}

/**
 * Cancels one active entry atomically and scrubs its private body.
 * A transaction with any attempted injection is marked ambiguous rather than claiming that
 * the recipient did not receive it. Terminal records remain unchanged.
 */
export async function cancelQueueEntry(runner, operatorPaneId, correlationId, options = {}) {
  return mutateQueueEntry(correlationId, options, (transaction) => {
    if (transaction.status !== "PENDING") return transaction;
    const checkpoint = transaction.checkpoint;
    const ambiguous = (checkpoint?.loadedUnits ?? 0) > 0 || checkpoint?.pendingAppendEnd || checkpoint?.submissionAttempted;
    return terminalize(transaction, "CANCELED", ambiguous ? "CANCELED_AMBIGUOUS" : "CANCELED_BY_OPERATOR");
  });
}

/**
 * Removes only terminal proof records for any local plugin caller.
 * Active queue entries and their pending bodies are never removed by this operation.
 */
export async function purgeQueueProofs(runner, operatorPaneId, options = {}) {
  const directory = options.directory || await resolveDataDirectory();
  return { removed: await pruneTerminalTransactions(directory, { retentionMs: 0, maximumTerminal: 0 }) };
}

/** Reports bounded daemon-independent queue state and threshold health without message content. */
export async function getServiceStatus(directory = undefined, options = {}) {
  const resolved = directory || await resolveDataDirectory();
  const config = { ...DEFAULT_PLUGIN_CONFIG, ...(options.config || {}) };
  const currentTime = Number.isFinite(options.now) ? options.now : Date.now();
  const counts = { DELIVERED: 0, PENDING: 0, CANCELED: 0, FAILED: 0 };
  let pendingBodyUnits = 0;
  let oldestPendingAt;
  let pendingHead;
  for (const path of await listTransactionPaths(resolved)) {
    const transaction = await readJson(path, undefined);
    if (!transaction || !Object.hasOwn(counts, transaction.status)) continue;
    counts[transaction.status] += 1;
    if (transaction.status === "PENDING") {
      if (typeof transaction.body === "string") pendingBodyUnits += transaction.body.length;
      if (!oldestPendingAt || transaction.createdAt < oldestPendingAt) oldestPendingAt = transaction.createdAt;
      if (!pendingHead || compareQueueEntries(transaction, pendingHead) < 0) pendingHead = transaction;
    }
  }
  const oldestPendingTime = oldestPendingAt ? Date.parse(oldestPendingAt) : Number.NaN;
  const oldestPendingAgeMs = Number.isFinite(oldestPendingTime) ? Math.max(0, currentTime - oldestPendingTime) : 0;
  const reasons = [];
  if (counts.PENDING > 0 && oldestPendingAgeMs >= config.pendingAlertAgeMs) reasons.push("PENDING_AGE_THRESHOLD_EXCEEDED");
  if (counts.PENDING >= config.pendingAlertCount) reasons.push("PENDING_COUNT_THRESHOLD_EXCEEDED");
  const pendingHealth = {
    level: reasons.length > 0 ? "ALERT" : "HEALTHY",
    reasons,
    pendingCount: counts.PENDING,
    oldestPendingAgeMs,
    thresholds: {
      ageMs: config.pendingAlertAgeMs,
      count: config.pendingAlertCount,
    },
    ...(pendingHead ? { head: pendingHealthHead(pendingHead) } : {}),
  };
  return {
    plugin: "herdr-reliable-messaging",
    directory: resolved,
    transactions: counts,
    pendingBodyUnits,
    pendingHealth,
    ...(oldestPendingAt ? { oldestPendingAt } : {}),
  };
}

/** Selects only body-free metadata needed to diagnose the oldest pending lane head. */
function pendingHealthHead(transaction) {
  return {
    correlationId: transaction.correlationId,
    queueSequence: transaction.queueSequence,
    recipientTitle: transaction.recipient?.title,
    code: transaction.code,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
  };
}

async function ensureRecipientPin(runner, transaction) {
  const checkpoint = transaction.checkpoint || initialComposerCheckpoint();
  if (transaction.recipient?.paneId) {
    try {
      if (await verifyPinnedPane(runner, transaction.recipient)) return { ready: true, transaction };
    } catch (error) {
      if (error?.code === "herdr_command_failed" || error?.code === "invalid_response") {
        return { ready: false, terminal: false, code: "HERDR_UNAVAILABLE" };
      }
      throw error;
    }
  }
  if ((checkpoint.loadedUnits ?? 0) > 0 || checkpoint.pendingAppendEnd || checkpoint.submissionAttempted) {
    return { ready: false, terminal: true, code: "FAILED_AMBIGUOUS_TARGET_LOST" };
  }
  try {
    return { ready: true, transaction: { ...transaction, recipient: pinPane(await resolveRecipientByTitle(runner, transaction.recipient.title)), updatedAt: new Date().toISOString() } };
  } catch (error) {
    if (isTransientTargetError(error)) return { ready: false, terminal: false, code: error.code };
    if (error?.code === "herdr_command_failed" || error?.code === "invalid_response") return { ready: false, terminal: false, code: "HERDR_UNAVAILABLE" };
    throw error;
  }
}

/**
 * Applies one caller-supplied atomic mutation to a legacy or batch-child queue record.
 * Exact correlation validation and a per-transaction lock prevent concurrent lost updates;
 * missing state fails without creating a record. The callback must not perform persistence.
 */
async function mutateQueueEntry(correlationId, options, mutation) {
  validateCorrelationId(correlationId);
  const directory = options.directory || await resolveDataDirectory();
  const path = await findTransactionPath(directory, correlationId);
  if (!path) throw serviceError("QUEUE_ENTRY_NOT_FOUND", "The requested queue entry does not exist.");
  const initial = await readJson(path, undefined);
  if (!initial) throw serviceError("QUEUE_ENTRY_NOT_FOUND", "The requested queue entry does not exist.");
  const release = await acquireStateLock(directory, `transaction:${initial.correlationId || correlationId}`, options.lockOptions);
  try {
    const current = await readJson(path, undefined);
    if (!current) throw serviceError("QUEUE_ENTRY_NOT_FOUND", "The requested queue entry does not exist.");
    const updated = mutation(current);
    await writeJson(path, updated);
    return queueSummary(updated);
  } finally {
    await release();
  }
}

function scheduleRetry(transaction, code, now = Date.now()) {
  const currentTime = now ?? Date.now();
  const retryCount = (Number.isSafeInteger(transaction.retryCount) ? transaction.retryCount : 0) + 1;
  const delayMs = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** Math.min(retryCount - 1, 10)));
  return { ...transaction, status: "PENDING", code, retryCount, lastAttemptAt: new Date(currentTime).toISOString(), nextAttemptAt: new Date(currentTime + delayMs).toISOString(), updatedAt: new Date(currentTime).toISOString() };
}

/** Schedules the next state-machine tick without treating normal observation as failure. */
function scheduleObservation(transaction, code, now = Date.now()) {
  const currentTime = Number.isFinite(now) ? now : Date.now();
  const waiting = { ...transaction, code, updatedAt: new Date(currentTime).toISOString() };
  waiting.nextAttemptAt = new Date(currentTime + OBSERVATION_DELAY_MS).toISOString();
  return waiting;
}

/** Returns a body-free terminal proof; callers atomically persist it while owning its lock. */
function terminalize(transaction, status, code, now = Date.now()) {
  const terminal = { ...transaction, status, code, updatedAt: new Date(now).toISOString() };
  delete terminal.body;
  delete terminal.nextAttemptAt;
  return terminal;
}

/** Reads live wall time unless a deterministic caller explicitly supplies a frozen or live clock. */
function transactionTime(options) {
  return options.clock ? options.clock() : options.now ?? Date.now();
}

/** Invalid legacy admission dates fail closed instead of granting an unlimited or renewed lease. */
function pendingExpired(transaction, now) {
  const created = Date.parse(transaction.createdAt || "");
  return !Number.isFinite(created) || now >= created + MAX_PENDING_AGE_MS;
}

/**
 * Commits expiration without Herdr access, cleanup, replay, or a false delivery claim.
 * The original checkpoint and failure code survive; bodies are scrubbed atomically using
 * existing proof retention. Possible orphan content is reported, never cleared speculatively.
 * Only call after rereading under the transaction lock. Alert failures cannot undo this write.
 */
async function persistExpiration(path, transaction, now) {
  const created = Date.parse(transaction.createdAt || "");
  const checkpoint = transaction.checkpoint || {};
  const terminal = terminalize(transaction, "FAILED", Number.isFinite(created) ? "DELIVERY_EXPIRED" : "PENDING_CREATED_AT_INVALID", now);
  terminal.previousCode = transaction.code;
  terminal.expiredAt = new Date(now).toISOString();
  if (Number.isFinite(created)) terminal.expiresAt = new Date(created + MAX_PENDING_AGE_MS).toISOString();
  terminal.receiptOutcome = checkpoint.submissionAttempted === true ? "UNKNOWN" : "NOT_CONFIRMED";
  terminal.composerState = checkpoint.submissionAttempted === true || (checkpoint.appendAttempts ?? 0) > 0 ||
    (checkpoint.loadedUnits ?? 0) > 0 || Number.isInteger(checkpoint.pendingAppendEnd)
    ? "POSSIBLE_ORPHAN_PRESERVED" : "UNTOUCHED";
  await writeJson(path, terminal);
  return publicResult(terminal, terminal.status, terminal.code);
}

/**
 * Rechecks the immutable admission deadline around every awaited Herdr call, including
 * immediately before append/submit. A call already started cannot be undone; the checkpoint
 * remains conservative and late results cannot trigger another action or delivery success.
 */
function guardTransactionDeadline(runner, transaction, options) {
  /** Rejects late access without exposing a body or invoking the underlying runner. */
  const check = () => {
    const now = transactionTime(options);
    if (pendingExpired(transaction, now)) {
      throw serviceError("DELIVERY_DEADLINE_REACHED", "The durable message lifetime has elapsed.");
    }
    return { timeoutMs: Math.max(1, Math.ceil(Date.parse(transaction.createdAt) + MAX_PENDING_AGE_MS - now)) };
  };
  return {
    /** Preserves runner binding and brackets structured commands with deadline checks. */
    async run(args) {
      const budget = check();
      try { return await runner.run(args, budget); }
      finally { check(); }
    },
    /** Preserves runner binding and rejects a snapshot/history result obtained too late. */
    async runText(args) {
      const budget = check();
      try { return await runner.runText(args, budget); }
      finally { check(); }
    },
  };
}

/** Verifies that persisted exact text still reconstructs every immutable chunk fingerprint. */
function assertStoredPayload(transaction, payload, chunks) {
  if (fingerprint(transaction.body) !== transaction.messageHash || fingerprint(payload) !== transaction.payloadHash ||
      chunks.length !== transaction.chunkHashes?.length ||
      !chunks.every((chunk, index) => fingerprint(chunk) === transaction.chunkHashes[index])) {
    throw serviceError("STORED_MESSAGE_MISMATCH", "The durable body does not match its persisted fingerprints.");
  }
}

function validateCorrelationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) throw serviceError("INVALID_CORRELATION", "The correlation identifier has an invalid format.");
}

/**
 * Builds one restart-safe child transaction for an atomically published batch.
 * The exact body is retained independently until this destination terminalizes, allowing other
 * destinations to progress and scrub without weakening restart recovery for this child.
 */
function createBatchTransaction({ batchCorrelationId, correlationId, queueSequence, now, sender, recipient, body, envelopeLimit }) {
  const payload = serializeEnvelope(sender.title, recipient.title, body);
  const chunks = createComposerChunks(payload, envelopeLimit);
  return {
    version: COMPACT_ENVELOPE_TRANSACTION_VERSION,
    batchCorrelationId,
    correlationId,
    queueSequence,
    createdAt: now,
    updatedAt: now,
    status: "PENDING",
    code: "QUEUED_FOR_DELIVERY",
    alertPolicy: "sender-notify-v1",
    sender,
    recipient,
    body,
    messageHash: fingerprint(body),
    messageLength: body.length,
    payloadHash: fingerprint(payload),
    payloadLength: payload.length,
    envelopeLimit,
    chunkHashes: chunks.map((chunk) => fingerprint(chunk)),
    chunkLengths: chunks.map((chunk) => chunk.length),
    checkpoint: initialComposerCheckpoint(),
    retryCount: 0,
    nextAttemptAt: now,
  };
}

/**
 * Derives a deterministic fixed-length child identity from exact ordered batch inputs.
 * The SHA-256 projection avoids embedding pane titles in paths or public child identifiers;
 * changing order or exact title intentionally produces a different correlation.
 */
function childCorrelationId(batchCorrelationId, recipientTitle, index) {
  return `batch-${fingerprint(`${batchCorrelationId}\u0000${index}\u0000${recipientTitle}`).slice(0, 48)}`;
}

/**
 * Verifies idempotent batch replay against every immutable exact input.
 * Any sender, ordered-title, body-hash, or envelope-limit difference fails before state changes.
 */
function assertMatchingBatch(manifest, batchCorrelationId, sender, recipientTitles, messageHash, envelopeLimit) {
  const matches = manifest.batchCorrelationId === batchCorrelationId &&
    sameSenderIdentity(manifest.sender, sender) && manifest.messageHash === messageHash &&
    manifest.envelopeLimit === envelopeLimit && Array.isArray(manifest.recipientTitles) &&
    manifest.recipientTitles.length === recipientTitles.length &&
    manifest.recipientTitles.every((title, index) => title === recipientTitles[index]);
  if (!matches) throw serviceError("BATCH_CORRELATION_CONFLICT", "The batch correlation belongs to different exact inputs.");
}

/**
 * Projects aggregate and ordered per-destination state without returning retained bodies.
 * A forced admission status is used only for enqueue responses; persisted snapshots derive
 * `PENDING`, homogeneous terminal state, or `MIXED` from every child.
 */
function batchResult(manifest, transactions, forcedStatus = undefined, forcedCode = undefined) {
  const counts = { pending: 0, delivered: 0, failed: 0, canceled: 0 };
  for (const transaction of transactions) {
    if (transaction.status === "PENDING") counts.pending += 1;
    else if (transaction.status === "DELIVERED") counts.delivered += 1;
    else if (transaction.status === "FAILED") counts.failed += 1;
    else if (transaction.status === "CANCELED") counts.canceled += 1;
  }
  let status = forcedStatus;
  if (!status) {
    if (counts.pending > 0) status = "PENDING";
    else if (counts.delivered === transactions.length) status = "DELIVERED";
    else if (counts.failed === transactions.length) status = "FAILED";
    else if (counts.canceled === transactions.length) status = "CANCELED";
    else status = "MIXED";
  }
  return {
    batchCorrelationId: manifest.batchCorrelationId,
    status,
    code: forcedCode || `BATCH_${status}`,
    createdAt: manifest.createdAt,
    senderTitle: manifest.sender?.title,
    total: transactions.length,
    ...counts,
    results: transactions.map(queueSummary),
  };
}

/** Rejects correlation reuse unless every exact endpoint, body, payload, and chunk matches. */
function assertMatchingTransaction(transaction, correlationId, sender, recipientTitle, body, messageHash, envelopeLimit) {
  const storedEnvelopeLimit = transaction.envelopeLimit;
  let payload;
  let chunks;
  try {
    payload = serializeTransactionEnvelope(transaction.version, sender.title, recipientTitle, body);
    chunks = createComposerChunks(payload, storedEnvelopeLimit);
  } catch {
    throw serviceError("CORRELATION_CONFLICT", "The correlation identifier belongs to an unsupported exact transaction.");
  }
  const matches = transaction.correlationId === correlationId && sameSenderIdentity(transaction.sender, sender) &&
    transaction.recipient?.title === recipientTitle && transaction.messageHash === messageHash &&
    transaction.payloadHash === fingerprint(payload) &&
    Array.isArray(transaction.chunkHashes) && storedEnvelopeLimit === envelopeLimit &&
    transaction.chunkHashes.length === chunks.length &&
    transaction.chunkHashes.every((value, index) => value === fingerprint(chunks[index]));
  if (!matches) throw serviceError("CORRELATION_CONFLICT", "The correlation identifier belongs to a different exact transaction.");
}

/**
 * Classifies only exact-title absence as transient before any composer content is loaded.
 * Ambiguity is deliberately excluded so duplicate live titles surface synchronously with
 * correction candidates instead of entering a destination lane with no unique identity.
 */
function isTransientTargetError(error) {
  return error?.code === "TARGET_UNAVAILABLE";
}

function diagnostic(transaction, stage, outcome) {
  return { correlationId: transaction.correlationId, senderTitle: transaction.sender.title, recipientTitle: transaction.recipient.title, messageLength: transaction.messageLength, messageHash: transaction.messageHash, stage, outcome, status: transaction.status, code: transaction.code };
}

/** Projects bounded body-free metadata, including stable expiration evidence, for all result views. */
function queueSummary(transaction) {
  const checkpoint = transaction.checkpoint || {};
  return {
    correlationId: transaction.correlationId,
    queueSequence: transaction.queueSequence,
    status: transaction.status,
    code: transaction.code,
    ...(transaction.expiredAt ? {
      previousCode: transaction.previousCode,
      expiredAt: transaction.expiredAt,
      expiresAt: transaction.expiresAt,
      receiptOutcome: transaction.receiptOutcome,
      composerState: transaction.composerState,
      detail: receiptDetail(transaction.status, transaction.code, transaction.receiptOutcome, transaction.composerState),
    } : {}),
    senderTitle: transaction.sender?.title,
    recipientTitle: transaction.recipient?.title,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    messageLength: transaction.messageLength,
    maxMessageUnits: transaction.envelopeLimit,
    loadedUnits: checkpoint.loadedUnits ?? 0,
    loadedChunks: checkpoint.loadedChunks ?? 0,
    totalChunks: transaction.chunkHashes?.length,
    submissionAttempted: checkpoint.submissionAttempted === true,
    submitAttempts: checkpoint.submitAttempts ?? 0,
    retryCount: transaction.retryCount || 0,
    ...(transaction.lastAttemptAt ? { lastAttemptAt: transaction.lastAttemptAt } : {}),
    ...(transaction.nextAttemptAt ? { nextAttemptAt: transaction.nextAttemptAt } : {}),
  };
}

/** Returns one deterministic readable explanation while preserving the stable code. */
function receiptDetail(status, code, receiptOutcome, composerState) {
  if (code === "DELIVERY_EXPIRED" || code === "PENDING_CREATED_AT_INVALID") {
    return `${code === "DELIVERY_EXPIRED" ? "Delivery expired after five minutes" : "Delivery stopped: invalid admission time"}; ${receiptOutcome === "UNKNOWN" ? "receipt outcome unknown after a submission attempt" : "delivery not confirmed"}. No automatic replay.${composerState === "POSSIBLE_ORPHAN_PRESERVED" ? " Possible composer fragment preserved; UI may remain obstructed." : ""}`;
  }
  if (status === "DELIVERED") return "Delivery confirmed.";
  if (status === "FAILED") return `Delivery failed (${code || "UNKNOWN"}).`;
  if (status === "CANCELED") return `Delivery canceled (${code || "UNKNOWN"}).`;
  return `Delivery pending (${code || "UNKNOWN"}); the dispatcher will retry automatically.`;
}

/** Allocates the next durable arrival order while the admission critical section is held. */
async function nextQueueSequence(directory) {
  let maximum = 0;
  for (const path of await listTransactionPaths(directory)) {
    const transaction = await readJson(path, undefined);
    if (Number.isSafeInteger(transaction?.queueSequence) && transaction.queueSequence > maximum) {
      maximum = transaction.queueSequence;
    }
  }
  return maximum + 1;
}

/** Compares queue entries by durable arrival sequence with an exact legacy fallback. */
function compareQueueEntries(left, right) {
  if (Number.isSafeInteger(left.queueSequence) && Number.isSafeInteger(right.queueSequence) && left.queueSequence !== right.queueSequence) {
    return left.queueSequence - right.queueSequence;
  }
  return compareOrdinal(left.createdAt || "", right.createdAt || "") || compareOrdinal(left.correlationId || "", right.correlationId || "");
}

function publicResult(transaction, status, code) {
  return { ...queueSummary(transaction), status, code };
}

/**
 * Creates a stable service error with optional body-free correction metadata.
 * Details are attached only when explicitly supplied; the helper performs no logging,
 * persistence, normalization, or message-body inspection.
 */
function serviceError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

/** Compares canonical persisted identifiers by exact UTF-16 code-unit order. */
function compareOrdinal(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
