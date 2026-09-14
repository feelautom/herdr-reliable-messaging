import { MAX_SUBMIT_ATTEMPTS } from "./constants.mjs";
import { appendComposerText, getAgent, readDetection, readRecentHistory, submitExactComposer } from "./herdr.mjs";

/** Consecutive empty snapshots required before a confirmed prefix is declared lost. */
const MAX_MISSING_COMPOSER_OBSERVATIONS = 2;

/** Consecutive writable snapshots required before an unobserved append is declared lost. */
const MAX_MISSING_APPEND_OBSERVATIONS = 2;

/** Minimum continuous writable interval before an unobserved append may fail closed. */
const MIN_MISSING_APPEND_WINDOW_MS = 5_000;

/** Creates the persisted state for loading and submitting one complete message. */
export function initialComposerCheckpoint() {
  return {
    loadedUnits: 0,
    loadedChunks: 0,
    appendAttempts: 0,
    readyObservations: 0,
    submissionAttempted: false,
    submitAttempts: 0,
    proofObservations: 0,
  };
}

/** Backward-compatible name for callers that create a fresh delivery checkpoint. */
export function initialCheckpoint() {
  return initialComposerCheckpoint();
}

/**
 * Advances one complete serialized message by one non-blocking scheduler action.
 *
 * The function appends at most one exact chunk without Enter, verifies the resulting
 * composer prefix on a later tick, and persists before every ambiguous terminal write.
 * It submits only after two full-composer observations. Delivery requires two later
 * observations of an empty composer plus a newly visible exact receipt. If a previously
 * confirmed prefix or pending append disappears before submission, bounded writable exact
 * prior-prefix evidence fails the transaction without reinjection. Pending append failure
 * additionally requires fresh reads across a minimum time window. Exact reappearance clears
 * the corresponding loss evidence.
 */
export async function advanceComposerMessage(
  runner,
  paneId,
  payload,
  chunkLimit,
  checkpoint,
  persist,
  trace = async () => {},
  options = {},
) {
  const currentTime = Number.isFinite(options.now) ? options.now : Date.now();
  let agent;
  let snapshot;
  try {
    [agent, snapshot] = await Promise.all([getAgent(runner, paneId), readDetection(runner, paneId)]);
  } catch (error) {
    await trace(event("snapshot", "failed", checkpoint, safeError(error)));
    return result("PENDING", "SNAPSHOT_UNAVAILABLE", paneId, checkpoint);
  }

  let evidence = inspectEvidence(snapshot, payload, checkpoint);
  await trace(event("snapshot", "observed", checkpoint, undefined, agent, evidence));
  if (checkpoint.submissionAttempted === true) {
    return advanceSubmittedMessage(runner, paneId, payload, checkpoint, persist, trace, agent, evidence);
  }

  const loadedUnits = checkpoint.loadedUnits ?? 0;
  const pendingAppendEnd = checkpoint.pendingAppendEnd;
  if (!Number.isInteger(pendingAppendEnd) && loadedUnits < payload.length &&
      (checkpoint.appendAttempts ?? 0) > (checkpoint.loadedChunks ?? 0)) {
    const recoverableEnd = nextChunkEnd(payload, loadedUnits, chunkLimit);
    const recoveryEvidence = inspectEvidence(snapshot, payload, { ...checkpoint, pendingAppendEnd: recoverableEnd });
    if (recoveryEvidence.composerUnits === recoverableEnd) {
      const recovered = {
        ...checkpoint,
        loadedUnits: recoverableEnd,
        loadedChunks: (checkpoint.loadedChunks ?? 0) + 1,
        readyObservations: 0,
      };
      delete recovered.pendingAppendAccepted;
      await persist(recovered);
      await trace(event("composer_append", "recovered", recovered, `${loadedUnits}:${recoverableEnd}`, agent, recoveryEvidence));
      return result("PENDING", recoverableEnd === payload.length ? "COMPOSER_LOADED" : "CHUNK_CONFIRMED", paneId, recovered);
    }
    evidence = recoveryEvidence;
  }
  if (Number.isInteger(pendingAppendEnd) && pendingAppendEnd > loadedUnits) {
    if (composerRepresentsUnits(evidence, pendingAppendEnd)) {
      const confirmed = {
        ...checkpoint,
        loadedUnits: pendingAppendEnd,
        loadedChunks: (checkpoint.loadedChunks ?? 0) + 1,
        readyObservations: 0,
      };
      delete confirmed.pendingAppendEnd;
      delete confirmed.pendingAppendAccepted;
      delete confirmed.missingAppendObservations;
      delete confirmed.missingAppendFirstObservedAt;
      delete confirmed.missingAppendLastObservedAt;
      await persist(confirmed);
      return result("PENDING", pendingAppendEnd === payload.length ? "COMPOSER_LOADED" : "CHUNK_CONFIRMED", paneId, confirmed);
    }
    if (composerRepresentsUnits(evidence, loadedUnits)) {
      if (!canWriteComposer(agent.agent_status)) {
        const paused = clearMissingAppendEvidence(checkpoint);
        if (paused !== checkpoint) await persist(paused);
        return result("PENDING", agent.agent_status === "blocked" ? "BLOCKING_UI" : "TARGET_NOT_SETTLED", paneId, paused);
      }
      const firstObservedAt = checkpoint.missingAppendFirstObservedAt;
      const lastObservedAt = checkpoint.missingAppendLastObservedAt;
      if (!Number.isFinite(firstObservedAt) || !Number.isFinite(lastObservedAt)) {
        const firstMissing = {
          ...checkpoint,
          missingAppendObservations: 1,
          missingAppendFirstObservedAt: currentTime,
          missingAppendLastObservedAt: currentTime,
          readyObservations: 0,
        };
        await persist(firstMissing);
        return result("PENDING", "APPEND_RECONCILIATION_REQUIRED", paneId, firstMissing);
      }
      if (currentTime <= lastObservedAt) {
        return result("PENDING", "APPEND_RECONCILIATION_REQUIRED", paneId, checkpoint);
      }
      if (currentTime - firstObservedAt < MIN_MISSING_APPEND_WINDOW_MS) {
        const observing = { ...checkpoint, missingAppendLastObservedAt: currentTime };
        await persist(observing);
        return result("PENDING", "APPEND_RECONCILIATION_REQUIRED", paneId, observing);
      }
      const missingAppendObservations = (checkpoint.missingAppendObservations ?? 0) + 1;
      const missing = {
        ...checkpoint,
        missingAppendObservations,
        missingAppendLastObservedAt: currentTime,
        readyObservations: 0,
      };
      await persist(missing);
      if (missingAppendObservations >= MAX_MISSING_APPEND_OBSERVATIONS) {
        return result("FAILED", "FAILED_AMBIGUOUS_APPEND_LOST", paneId, missing);
      }
      return result("PENDING", "APPEND_RECONCILIATION_REQUIRED", paneId, missing);
    }
    if (Object.hasOwn(checkpoint, "missingAppendObservations")) {
      const ambiguous = clearMissingAppendEvidence(checkpoint);
      await persist(ambiguous);
      return result("PENDING", "APPEND_AMBIGUOUS", paneId, ambiguous);
    }
    return result("PENDING", "APPEND_AMBIGUOUS", paneId, checkpoint);
  }

  if (loadedUnits > 0 && evidence.composerEmpty && !canWriteComposer(agent.agent_status)) {
    return result("PENDING", agent.agent_status === "blocked" ? "BLOCKING_UI" : "TARGET_NOT_SETTLED", paneId, checkpoint);
  }
  if (loadedUnits > 0 && evidence.composerEmpty) {
    const missingComposerObservations = (checkpoint.missingComposerObservations ?? 0) + 1;
    const missing = {
      ...checkpoint,
      missingComposerObservations,
      readyObservations: 0,
    };
    await persist(missing);
    if (missingComposerObservations >= MAX_MISSING_COMPOSER_OBSERVATIONS) {
      return result("FAILED", "FAILED_AMBIGUOUS_COMPOSER_LOST", paneId, missing);
    }
    return result("PENDING", "COMPOSER_RECONCILIATION_REQUIRED", paneId, missing);
  }
  if (!composerRepresentsUnits(evidence, loadedUnits)) {
    return result("PENDING", "TARGET_COMPOSER_OCCUPIED", paneId, checkpoint);
  }
  if (Object.hasOwn(checkpoint, "missingComposerObservations")) {
    const reconciled = { ...checkpoint, readyObservations: 0 };
    delete reconciled.missingComposerObservations;
    await persist(reconciled);
    return result("PENDING", "COMPOSER_RECONCILED", paneId, reconciled);
  }
  if (!canWriteComposer(agent.agent_status)) {
    return result("PENDING", agent.agent_status === "blocked" ? "BLOCKING_UI" : "TARGET_NOT_SETTLED", paneId, checkpoint);
  }

  if (loadedUnits < payload.length) {
    const appendEnd = nextChunkEnd(payload, loadedUnits, chunkLimit);
    const appending = {
      ...checkpoint,
      pendingAppendEnd: appendEnd,
      appendAttempts: (checkpoint.appendAttempts ?? 0) + 1,
      readyObservations: 0,
      baselineSubmittedCount: checkpoint.baselineSubmittedCount ?? evidence.submittedCount,
      baselineQueuedCount: checkpoint.baselineQueuedCount ?? evidence.queuedCount,
    };
    await persist(appending);
    await trace(event("composer_append", "started", appending, `${loadedUnits}:${appendEnd}`, agent, evidence));
    try {
      await appendComposerText(runner, paneId, payload.slice(loadedUnits, appendEnd));
      const accepted = { ...appending, pendingAppendAccepted: true };
      await persist(accepted);
      return result("PENDING", "CHUNK_APPEND_SENT", paneId, accepted);
    } catch (error) {
      await trace(event("composer_append", "failed", appending, safeError(error), agent, evidence));
      return result("PENDING", "APPEND_FAILED_AMBIGUOUS", paneId, appending);
    }
  }

  const observed = { ...checkpoint, readyObservations: (checkpoint.readyObservations ?? 0) + 1 };
  await persist(observed);
  if (observed.readyObservations < 2) {
    return result("PENDING", "SECOND_COMPOSER_OBSERVATION_REQUIRED", paneId, observed);
  }

  const submitting = {
    ...observed,
    submissionAttempted: true,
    submitAttempts: 1,
    proofObservations: 0,
    baselineAgentStatus: agent.agent_status,
    baselineStateChangeSeq: agent.state_change_seq,
    baselineRevision: agent.revision,
  };
  await persist(submitting);
  await trace(event("composer_submit", "started", submitting, "exact_enter_enter", agent, evidence));
  try {
    await submitExactComposer(runner, paneId);
    return result("PENDING", "SUBMIT_SENT", paneId, submitting);
  } catch (error) {
    await trace(event("composer_submit", "failed", submitting, safeError(error), agent, evidence));
    return result("PENDING", "SUBMIT_FAILED_AMBIGUOUS", paneId, submitting);
  }
}

/** Clears only append-loss observations while preserving the durable append intent. */
function clearMissingAppendEvidence(checkpoint) {
  if (!Object.hasOwn(checkpoint, "missingAppendObservations") &&
      !Object.hasOwn(checkpoint, "missingAppendFirstObservedAt") &&
      !Object.hasOwn(checkpoint, "missingAppendLastObservedAt")) return checkpoint;
  const cleared = { ...checkpoint };
  delete cleared.missingAppendObservations;
  delete cleared.missingAppendFirstObservedAt;
  delete cleared.missingAppendLastObservedAt;
  return cleared;
}

/**
 * Evaluates a message after its final submission gesture without reinjecting text.
 *
 * A still-exact full composer may receive one bounded retry. Otherwise delivery needs
 * an empty composer and a receipt count newer than the baseline captured before loading.
 */
async function advanceSubmittedMessage(runner, paneId, payload, checkpoint, persist, trace, agent, evidence) {
  let correlatedReceipt = evidence.submittedCount > (checkpoint.baselineSubmittedCount ?? 0) ||
    evidence.queuedCount > (checkpoint.baselineQueuedCount ?? 0);
  if (evidence.composerEmpty && !correlatedReceipt) {
    try {
      const historyEvidence = inspectEvidence(await readRecentHistory(runner, paneId), payload, checkpoint);
      correlatedReceipt = historyEvidence.submittedCount > (checkpoint.baselineSubmittedCount ?? 0) ||
        historyEvidence.queuedCount > (checkpoint.baselineQueuedCount ?? 0);
      await trace(event(
        "receipt_history",
        correlatedReceipt ? "observed" : "not_observed",
        checkpoint,
        undefined,
        agent,
        historyEvidence,
      ));
    } catch (error) {
      await trace(event("receipt_history", "failed", checkpoint, safeError(error), agent, evidence));
    }
  }
  const settledSubmissionBaseline = checkpoint.baselineAgentStatus === "idle" || checkpoint.baselineAgentStatus === "done";
  const causalLifecycleProgress = settledSubmissionBaseline && (
    (Number.isInteger(checkpoint.baselineStateChangeSeq) && agent.state_change_seq > checkpoint.baselineStateChangeSeq) ||
    (Number.isInteger(checkpoint.baselineRevision) && agent.revision > checkpoint.baselineRevision)
  );
  if (evidence.composerEmpty && (correlatedReceipt || causalLifecycleProgress)) {
    const proven = { ...checkpoint, proofObservations: (checkpoint.proofObservations ?? 0) + 1 };
    await persist(proven);
    if (proven.proofObservations >= 2) {
      await trace(event(
        "receipt",
        "delivered",
        proven,
        correlatedReceipt ? "empty_composer_and_exact_receipt" : "empty_composer_and_causal_lifecycle_progress",
        agent,
        evidence,
      ));
      return result("DELIVERED", "DELIVERY_CONFIRMED", paneId, proven);
    }
    return result("PENDING", "SECOND_DELIVERY_OBSERVATION_REQUIRED", paneId, proven);
  }

  if ((checkpoint.proofObservations ?? 0) !== 0) {
    const reset = { ...checkpoint, proofObservations: 0 };
    await persist(reset);
    checkpoint = reset;
  }
  if (evidence.composerUnits === payload.length) {
    if (!canWriteComposer(agent.agent_status) || evidence.blockingUi) {
      return result("PENDING", evidence.blockingUi ? "BLOCKING_UI" : "TARGET_NOT_SETTLED", paneId, checkpoint);
    }
    if ((checkpoint.submitAttempts ?? 0) >= MAX_SUBMIT_ATTEMPTS) {
      return result("PENDING", "SUBMIT_ATTEMPTS_EXHAUSTED", paneId, checkpoint);
    }
    const retrying = { ...checkpoint, submitAttempts: (checkpoint.submitAttempts ?? 0) + 1 };
    await persist(retrying);
    await trace(event("composer_submit", "started", retrying, "exact_enter_enter_retry", agent, evidence));
    try {
      await submitExactComposer(runner, paneId);
      return result("PENDING", "SUBMIT_SENT", paneId, retrying);
    } catch (error) {
      await trace(event("composer_submit", "failed", retrying, safeError(error), agent, evidence));
      return result("PENDING", "SUBMIT_FAILED_AMBIGUOUS", paneId, retrying);
    }
  }
  return result("PENDING", evidence.composerOccupied ? "TARGET_COMPOSER_OCCUPIED" : "SUBMISSION_UNPROVEN", paneId, checkpoint);
}

/** Extracts exact composer and receipt evidence without normalizing payload text. */
export function inspectEvidence(snapshot, payload, checkpoint = initialComposerCheckpoint()) {
  const promptEntries = extractVisualEntries(snapshot, "›");
  const queuedEntries = extractVisualEntries(snapshot, "↳");
  const submittedCount = promptEntries.filter((entry) => visualEntryMatches(entry, payload)).length;
  const queuedCount = queuedEntries.filter((entry) => visualEntryMatches(entry, payload)).length;
  const lastPrompt = promptEntries.at(-1);
  const lastPromptTail = lastPrompt ? snapshot.slice(lastPrompt.endOffset) : "";
  const lastPromptIsComposer = Boolean(lastPrompt && !hasPostPromptActivity(lastPromptTail));
  const composerEmpty = Boolean(lastPromptIsComposer && isEmptyComposerPlaceholder(lastPrompt));
  const candidates = [payload.length, checkpoint.pendingAppendEnd, checkpoint.loadedUnits]
    .filter((value, index, values) => Number.isInteger(value) && value > 0 && values.indexOf(value) === index);
  const composerUnits = lastPromptIsComposer && !composerEmpty
    ? candidates.find((units) => visualEntryMatches(lastPrompt, payload.slice(0, units)))
    : undefined;
  const composerEndUnits = lastPromptIsComposer && !composerEmpty && composerUnits === undefined
    ? candidates.find((units) => visualEntryMatchesSuffix(lastPrompt, payload.slice(0, units)))
    : undefined;
  const composerOccupied = Boolean(
    lastPromptIsComposer && !composerEmpty && composerUnits === undefined && composerEndUnits === undefined,
  );
  const blockingUi = /(?:allow command|do you want to proceed|press enter to confirm|select an option|approval required)/iu.test(snapshot);
  return { composerUnits, composerEndUnits, composerEmpty, composerOccupied, submittedCount, queuedCount, blockingUi };
}

/** Reconstructs prompt or queue entries split only by the visual continuation indent. */
export function extractVisualEntries(snapshot, marker) {
  const lines = snapshot.split(/\r?\n/u);
  const entries = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = new RegExp(`^\\s*${escapeRegExp(marker)} (.*)$`, "u").exec(line);
    const lineStart = offset;
    offset += line.length + 1;
    if (!match) continue;
    let value = match[1];
    const segments = [match[1]];
    let endOffset = offset;
    while (index + 1 < lines.length && /^  .+/u.test(lines[index + 1])) {
      index += 1;
      const continuation = lines[index];
      const segment = continuation.slice(2);
      segments.push(segment);
      value += segment;
      offset += continuation.length + 1;
      endOffset = offset;
    }
    entries.push({ value, segments, startOffset: lineStart, endOffset });
  }
  return entries;
}

/** Matches visually wrapped terminal segments against one exact opaque string. */
function visualEntryMatches(entry, payload) {
  if (entry.value === payload) return true;
  return visualSegmentsEndAt(entry, payload, 0);
}

/** Matches a composer viewport that shows only an exact suffix of a known prefix. */
function visualEntryMatchesSuffix(entry, payload) {
  const first = entry.segments?.[0] ?? entry.value;
  if (typeof first !== "string" || first.length === 0) return false;
  let start = payload.indexOf(first);
  while (start >= 0) {
    if (visualSegmentsEndAt(entry, payload, start)) return true;
    start = payload.indexOf(first, start + 1);
  }
  return false;
}

/** Matches exact visual segments from one explicit source-string offset to its end. */
function visualSegmentsEndAt(entry, payload, start) {
  const segments = Array.isArray(entry.segments) ? entry.segments : [entry.value];
  let cursors = new Set([start]);
  for (const segment of segments) {
    const next = new Set();
    for (const cursor of cursors) {
      if (!payload.startsWith(segment, cursor)) continue;
      const end = cursor + segment.length;
      next.add(end);
      if (payload[end] === " ") next.add(end + 1);
    }
    cursors = next;
    if (cursors.size === 0) return false;
  }
  return cursors.has(payload.length);
}

/** Returns whether the composer exactly represents one confirmed prefix length. */
function composerRepresentsUnits(evidence, units) {
  return units === 0
    ? evidence.composerEmpty
    : evidence.composerUnits === units || evidence.composerEndUnits === units;
}

/** Chooses an exact code-point-safe boundary for one append-only composer write. */
function nextChunkEnd(payload, start, maximum) {
  if (!Number.isInteger(maximum) || maximum < 1) throw Object.assign(new Error("Invalid composer chunk limit."), { code: "INVALID_LIMIT" });
  let end = Math.min(payload.length, start + maximum);
  if (end < payload.length && end > start) {
    const code = payload.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  if (end <= start) throw Object.assign(new Error("A Unicode code point cannot fit in one composer chunk."), { code: "CHUNK_TOO_LONG" });
  return end;
}

/**
 * Reports whether Herdr can accept an exact append or submission gesture.
 *
 * Codex queues or steers input received while it is working. Composer ownership and
 * blocking-UI evidence remain separate mandatory guards before this predicate is used.
 */
function canWriteComposer(status) {
  return status === "idle" || status === "done" || status === "working";
}

/** Recognizes only Codex's known empty-composer placeholders. */
function isEmptyComposerPlaceholder(entry) {
  return entry.segments.length === 1 && /^(?:Ask Codex|Ask Codex to do anything)$/u.test(entry.value);
}

/** Detects visible activity after a prompt entry while ignoring stable Codex footers. */
function hasPostPromptActivity(tail) {
  return tail.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 &&
      !/^gpt-[\w.-]+/u.test(trimmed) &&
      !/^tab to queue message(?:\s+\d+% context left)?$/u.test(trimmed);
  });
}

/** Escapes one exact marker before constructing the visual-entry regular expression. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Creates one stable state-machine result without exposing message content. */
function result(status, code, targetPaneId, checkpoint) {
  return { status, code, targetPaneId, checkpoint };
}

/** Builds one body-free structured diagnostic event for a delivery transition. */
function event(stage, outcome, checkpoint, detail, agent, evidence) {
  return {
    stage,
    outcome,
    ...(detail ? { detail } : {}),
    loadedUnits: checkpoint.loadedUnits ?? 0,
    loadedChunks: checkpoint.loadedChunks ?? 0,
    appendAttempts: checkpoint.appendAttempts ?? 0,
    submissionAttempted: checkpoint.submissionAttempted === true,
    submitAttempts: checkpoint.submitAttempts ?? 0,
    proofObservations: checkpoint.proofObservations ?? 0,
    ...(agent ? { agentStatus: agent.agent_status, stateChangeSeq: agent.state_change_seq, revision: agent.revision } : {}),
    ...(evidence ? {
      composerUnits: evidence.composerUnits,
      composerEndUnits: evidence.composerEndUnits,
      composerEmpty: evidence.composerEmpty,
      composerOccupied: evidence.composerOccupied,
      submittedCount: evidence.submittedCount,
      queuedCount: evidence.queuedCount,
      blockingUi: evidence.blockingUi,
    } : {}),
  };
}

/** Reduces an operational exception to a stable non-secret diagnostic code. */
function safeError(error) {
  return typeof error?.code === "string" ? error.code : "unknown_error";
}
