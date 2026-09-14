import test from "node:test";
import assert from "node:assert/strict";
import { advanceComposerMessage, extractVisualEntries, initialComposerCheckpoint, inspectEvidence } from "../src/delivery.mjs";

const PAYLOAD = `[SOURCE PANE:TARGET PANE] ${"exact payload block ".repeat(70)}`;

test("loads one long message in bounded chunks and submits it exactly once", async () => {
  const runner = new ComposerRunner();
  let checkpoint = initialComposerCheckpoint();
  const persist = async (value) => { checkpoint = { ...value }; };
  let outcome;

  for (let tick = 0; tick < 30; tick += 1) {
    outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);
    checkpoint = outcome.checkpoint;
    if (outcome.status === "DELIVERED") break;
  }

  assert.equal(outcome.status, "DELIVERED");
  assert.equal(runner.appendedChunks.join(""), PAYLOAD);
  assert.ok(runner.appendedChunks.length > 1);
  assert.ok(runner.appendedChunks.every((chunk) => chunk.length <= 500));
  assert.equal(runner.submitCalls, 1);
  assert.deepEqual(runner.submittedPayloads, [PAYLOAD]);
  assert.equal(runner.composer, "");
});

test("recovers an append persisted before a crash without duplicating the chunk", async () => {
  const runner = new ComposerRunner();
  const firstChunk = PAYLOAD.slice(0, 500);
  runner.composer = firstChunk;
  runner.refreshSnapshot();
  let checkpoint = {
    ...initialComposerCheckpoint(),
    pendingAppendEnd: 500,
    appendAttempts: 1,
    baselineSubmittedCount: 0,
    baselineQueuedCount: 0,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);
  assert.equal(outcome.code, "CHUNK_CONFIRMED");
  assert.equal(outcome.checkpoint.loadedUnits, 500);
  assert.equal(runner.appendedChunks.length, 0);
  assert.equal(runner.composer, firstChunk);
});

test("keeps a delayed append pending until its exact prefix becomes visible", async () => {
  const runner = new ComposerRunner();
  const firstChunk = PAYLOAD.slice(0, 500);
  const observedAt = 1_000_000;
  let checkpoint = {
    ...initialComposerCheckpoint(),
    pendingAppendEnd: 500,
    pendingAppendAccepted: true,
    appendAttempts: 1,
    baselineSubmittedCount: 0,
    baselineQueuedCount: 0,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const delayed = await advanceComposerMessage(
    runner, "target", PAYLOAD, 500, checkpoint, persist, async () => {}, { now: observedAt },
  );
  assert.equal(delayed.code, "APPEND_RECONCILIATION_REQUIRED");
  assert.equal(delayed.checkpoint.pendingAppendEnd, 500);
  assert.equal(delayed.checkpoint.missingAppendObservations, 1);
  assert.equal(runner.appendedChunks.length, 0);

  runner.composer = firstChunk;
  runner.refreshSnapshot();
  const confirmed = await advanceComposerMessage(
    runner, "target", PAYLOAD, 500, delayed.checkpoint, persist, async () => {}, { now: observedAt + 4_999 },
  );
  assert.equal(confirmed.code, "CHUNK_CONFIRMED");
  assert.equal(confirmed.checkpoint.loadedUnits, 500);
  assert.equal(Object.hasOwn(confirmed.checkpoint, "missingAppendObservations"), false);
  assert.equal(runner.appendedChunks.length, 0);
});

// A persisted append that never becomes visible must not poison its destination lane forever.
test("fails an unobserved pending append after bounded writable empty observations", async () => {
  const runner = new ComposerRunner();
  const observedAt = 2_000_000;
  let checkpoint = {
    ...initialComposerCheckpoint(),
    pendingAppendEnd: 500,
    pendingAppendAccepted: true,
    appendAttempts: 1,
    baselineSubmittedCount: 0,
    baselineQueuedCount: 0,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const first = await advanceComposerMessage(
    runner, "target", PAYLOAD, 500, checkpoint, persist, async () => {}, { now: observedAt },
  );
  checkpoint = structuredClone(first.checkpoint);
  const sameSnapshotTime = await advanceComposerMessage(
    runner, "target", PAYLOAD, 500, checkpoint, persist, async () => {}, { now: observedAt },
  );
  checkpoint = structuredClone(sameSnapshotTime.checkpoint);
  const early = await advanceComposerMessage(
    runner, "target", PAYLOAD, 500, checkpoint, persist, async () => {}, { now: observedAt + 1_000 },
  );
  checkpoint = structuredClone(early.checkpoint);
  const second = await advanceComposerMessage(
    runner, "target", PAYLOAD, 500, checkpoint, persist, async () => {}, { now: observedAt + 5_000 },
  );

  assert.equal(first.status, "PENDING");
  assert.equal(first.code, "APPEND_RECONCILIATION_REQUIRED");
  assert.equal(first.checkpoint.missingAppendObservations, 1);
  assert.equal(sameSnapshotTime.checkpoint.missingAppendObservations, 1);
  assert.equal(early.status, "PENDING");
  assert.equal(early.checkpoint.missingAppendObservations, 1);
  assert.equal(second.status, "FAILED");
  assert.equal(second.code, "FAILED_AMBIGUOUS_APPEND_LOST");
  assert.equal(runner.appendedChunks.length, 0);
  assert.equal(runner.submitCalls, 0);
});

// The same bounded policy applies after earlier chunks were already confirmed exactly.
test("bounds an unobserved later chunk from a confirmed composer prefix", async () => {
  const runner = new ComposerRunner();
  const prefix = PAYLOAD.slice(0, 500);
  runner.composer = prefix;
  runner.refreshSnapshot();
  let checkpoint = {
    ...initialComposerCheckpoint(),
    loadedUnits: 500,
    loadedChunks: 1,
    pendingAppendEnd: 1_000,
    pendingAppendAccepted: true,
    appendAttempts: 2,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const first = await advanceComposerMessage(
    runner, "target", PAYLOAD, 500, checkpoint, persist, async () => {}, { now: 3_000_000 },
  );
  const failed = await advanceComposerMessage(
    runner, "target", PAYLOAD, 500, structuredClone(first.checkpoint), persist, async () => {}, { now: 3_005_000 },
  );

  assert.equal(first.code, "APPEND_RECONCILIATION_REQUIRED");
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.code, "FAILED_AMBIGUOUS_APPEND_LOST");
  assert.equal(runner.composer, prefix);
  assert.equal(runner.appendedChunks.length, 0);
  assert.equal(runner.submitCalls, 0);
});

// Blocked and unknown targets cannot prove whether Herdr accepted a previously attempted append.
test("does not count an unobserved pending append while the target is blocked or unknown", async () => {
  for (const [status, expectedCode] of [["blocked", "BLOCKING_UI"], ["unknown", "TARGET_NOT_SETTLED"]]) {
    const runner = new ComposerRunner();
    runner.status = status;
    const checkpoint = {
      ...initialComposerCheckpoint(),
      pendingAppendEnd: 500,
      pendingAppendAccepted: true,
      appendAttempts: 1,
      missingAppendObservations: 1,
      missingAppendFirstObservedAt: 1_000_000,
      missingAppendLastObservedAt: 1_000_000,
    };

    const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, async () => {});

    assert.equal(outcome.status, "PENDING");
    assert.equal(outcome.code, expectedCode);
    assert.equal(Object.hasOwn(outcome.checkpoint, "missingAppendObservations"), false);
    assert.equal(Object.hasOwn(outcome.checkpoint, "missingAppendFirstObservedAt"), false);
    assert.equal(Object.hasOwn(outcome.checkpoint, "missingAppendLastObservedAt"), false);
    assert.equal(runner.appendedChunks.length, 0);
    assert.equal(runner.submitCalls, 0);
  }
});

test("recovers an exact orphaned prefix without appending it again", async () => {
  const runner = new ComposerRunner();
  runner.composer = PAYLOAD.slice(0, 500);
  runner.refreshSnapshot();
  let checkpoint = {
    ...initialComposerCheckpoint(),
    appendAttempts: 1,
    baselineSubmittedCount: 0,
    baselineQueuedCount: 0,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const recovered = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);
  assert.equal(recovered.code, "CHUNK_CONFIRMED");
  assert.equal(recovered.checkpoint.loadedUnits, 500);
  assert.equal(runner.appendedChunks.length, 0);
});

test("confirms a pending append from the exact scrolled composer suffix", async () => {
  const runner = new ComposerRunner();
  runner.snapshot = `› ${PAYLOAD.slice(700)}`;
  let checkpoint = {
    ...initialComposerCheckpoint(),
    loadedUnits: 1_000,
    loadedChunks: 2,
    appendAttempts: 3,
    pendingAppendEnd: PAYLOAD.length,
    pendingAppendAccepted: true,
    baselineSubmittedCount: 0,
    baselineQueuedCount: 0,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const confirmed = await advanceComposerMessage(
    runner,
    "target",
    PAYLOAD,
    500,
    checkpoint,
    persist,
  );
  assert.equal(confirmed.code, "COMPOSER_LOADED");
  assert.equal(confirmed.checkpoint.loadedUnits, PAYLOAD.length);
  assert.equal(runner.appendedChunks.length, 0);
});

test("never confirms delivery while the complete message remains in the composer", async () => {
  const runner = new ComposerRunner({ submitLeavesComposer: true });
  runner.composer = PAYLOAD;
  runner.refreshSnapshot();
  let checkpoint = {
    ...initialComposerCheckpoint(),
    loadedUnits: PAYLOAD.length,
    loadedChunks: 3,
    readyObservations: 2,
    submissionAttempted: true,
    submitAttempts: 1,
    baselineSubmittedCount: 0,
    baselineQueuedCount: 0,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const first = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);
  checkpoint = first.checkpoint;
  const second = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);

  assert.equal(first.code, "SUBMIT_SENT");
  assert.equal(second.code, "SUBMIT_ATTEMPTS_EXHAUSTED");
  assert.equal(second.status, "PENDING");
  assert.equal(second.checkpoint.proofObservations, 0);
  assert.equal(runner.composer, PAYLOAD);
});

test("confirms a long receipt that left the viewport through causal lifecycle progress", async () => {
  const runner = new ComposerRunner();
  runner.stateChangeSeq = 8;
  runner.revision = 13;
  runner.refreshSnapshot();
  let checkpoint = {
    ...initialComposerCheckpoint(),
    loadedUnits: PAYLOAD.length,
    loadedChunks: 3,
    readyObservations: 2,
    submissionAttempted: true,
    submitAttempts: 1,
    baselineSubmittedCount: 0,
    baselineQueuedCount: 0,
    baselineAgentStatus: "idle",
    baselineStateChangeSeq: 7,
    baselineRevision: 12,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const first = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);
  checkpoint = first.checkpoint;
  const second = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);

  assert.equal(first.code, "SECOND_DELIVERY_OBSERVATION_REQUIRED");
  assert.equal(second.status, "DELIVERED");
  assert.equal(second.code, "DELIVERY_CONFIRMED");
  assert.equal(runner.submitCalls, 0);
});

test("finds an exact long receipt in deeper recent history after detection truncation", async () => {
  const runner = new ComposerRunner({ detectionHidesHistory: true });
  let checkpoint = initialComposerCheckpoint();
  const persist = async (value) => { checkpoint = { ...value }; };
  let outcome;

  for (let tick = 0; tick < 30; tick += 1) {
    outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);
    checkpoint = outcome.checkpoint;
    if (outcome.status === "DELIVERED") break;
  }

  assert.equal(outcome.status, "DELIVERED");
  assert.ok(runner.recentHistoryReads >= 2);
  assert.equal(runner.submitCalls, 1);
});

test("does not append into unrelated existing composer content", async () => {
  const runner = new ComposerRunner();
  runner.composer = "UNRELATED EXISTING COMPOSER TEXT";
  runner.refreshSnapshot();
  const outcome = await advanceComposerMessage(
    runner,
    "target",
    PAYLOAD,
    500,
    initialComposerCheckpoint(),
    async () => {},
  );
  assert.equal(outcome.code, "TARGET_COMPOSER_OCCUPIED");
  assert.equal(runner.appendedChunks.length, 0);
  assert.equal(runner.submitCalls, 0);
});

// A vanished confirmed prefix is ambiguous and must fail without replay after independent observations.
test("fails a disappeared confirmed composer prefix after bounded empty observations", async () => {
  const runner = new ComposerRunner();
  let checkpoint = {
    ...initialComposerCheckpoint(),
    loadedUnits: PAYLOAD.length,
    loadedChunks: 3,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const first = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);
  checkpoint = first.checkpoint;
  const second = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);

  assert.equal(first.status, "PENDING");
  assert.equal(first.code, "COMPOSER_RECONCILIATION_REQUIRED");
  assert.equal(first.checkpoint.missingComposerObservations, 1);
  assert.equal(second.status, "FAILED");
  assert.equal(second.code, "FAILED_AMBIGUOUS_COMPOSER_LOST");
  assert.equal(runner.appendedChunks.length, 0);
  assert.equal(runner.submitCalls, 0);
});

// Exact reappearance proves the durable checkpoint still owns the composer and cancels loss escalation.
test("clears composer-loss evidence when the exact confirmed prefix reappears", async () => {
  const runner = new ComposerRunner();
  const prefix = PAYLOAD.slice(0, 500);
  runner.composer = prefix;
  runner.refreshSnapshot();
  let checkpoint = {
    ...initialComposerCheckpoint(),
    loadedUnits: prefix.length,
    loadedChunks: 1,
    missingComposerObservations: 1,
  };
  const persist = async (value) => { checkpoint = { ...value }; };

  const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);

  assert.equal(outcome.status, "PENDING");
  assert.equal(outcome.code, "COMPOSER_RECONCILED");
  assert.equal(Object.hasOwn(outcome.checkpoint, "missingComposerObservations"), false);
  assert.equal(runner.appendedChunks.length, 0);
  assert.equal(runner.submitCalls, 0);
});

// Non-writable target states cannot provide safe negative evidence about composer ownership.
test("does not count composer loss while the target state is blocked or unknown", async () => {
  for (const [status, expectedCode] of [["blocked", "BLOCKING_UI"], ["unknown", "TARGET_NOT_SETTLED"]]) {
    const runner = new ComposerRunner();
    runner.status = status;
    const checkpoint = {
      ...initialComposerCheckpoint(),
      loadedUnits: PAYLOAD.length,
      loadedChunks: 3,
    };

    const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, async () => {});

    assert.equal(outcome.status, "PENDING");
    assert.equal(outcome.code, expectedCode);
    assert.equal(Object.hasOwn(outcome.checkpoint, "missingComposerObservations"), false);
    assert.equal(runner.appendedChunks.length, 0);
    assert.equal(runner.submitCalls, 0);
  }
});

test("loads and submits exactly once while the target remains working", async () => {
  const runner = new ComposerRunner();
  runner.status = "working";
  let checkpoint = initialComposerCheckpoint();
  const persist = async (value) => { checkpoint = { ...value }; };
  let outcome;

  for (let tick = 0; tick < 30; tick += 1) {
    outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);
    checkpoint = outcome.checkpoint;
    if (outcome.status === "DELIVERED") break;
  }

  assert.equal(outcome.status, "DELIVERED");
  assert.equal(runner.submitCalls, 1);
  assert.deepEqual(runner.submittedPayloads, [PAYLOAD]);
});

test("keeps a working target pending when its composer contains unrelated text", async () => {
  const runner = new ComposerRunner();
  runner.status = "working";
  runner.composer = "UNRELATED EXISTING COMPOSER TEXT";
  runner.refreshSnapshot();

  const outcome = await advanceComposerMessage(
    runner,
    "target",
    PAYLOAD,
    500,
    initialComposerCheckpoint(),
    async () => {},
  );

  assert.equal(outcome.code, "TARGET_COMPOSER_OCCUPIED");
  assert.equal(runner.appendedChunks.length, 0);
  assert.equal(runner.submitCalls, 0);
});

test("keeps blocked and unknown target states pending without composer writes", async () => {
  for (const [status, expectedCode] of [["blocked", "BLOCKING_UI"], ["unknown", "TARGET_NOT_SETTLED"]]) {
    const runner = new ComposerRunner();
    runner.status = status;
    const outcome = await advanceComposerMessage(
      runner,
      "target",
      PAYLOAD,
      500,
      initialComposerCheckpoint(),
      async () => {},
    );

    assert.equal(outcome.code, expectedCode);
    assert.equal(runner.appendedChunks.length, 0);
    assert.equal(runner.submitCalls, 0);
  }
});

test("recognizes exact visually wrapped prefixes without broad normalization", () => {
  const prefix = "[SOURCE PANE:TARGET PANE] exact payload block ";
  const wrapped = "› [SOURCE PANE:TARGET PANE] exact\n  payload block";
  const evidence = inspectEvidence(wrapped, PAYLOAD, {
    ...initialComposerCheckpoint(),
    loadedUnits: prefix.length,
  });
  assert.equal(evidence.composerUnits, prefix.length);
  assert.equal(evidence.composerOccupied, false);
  assert.equal(inspectEvidence(wrapped, PAYLOAD.replace("payload", "changed"), {
    ...initialComposerCheckpoint(),
    loadedUnits: prefix.length,
  }).composerOccupied, true);
});

test("extracts visually wrapped entries while preserving exact segment boundaries", () => {
  const wrapped = "› exact-long-pay\n  load-without-\n  spaces\n\n• Working";
  assert.deepEqual(extractVisualEntries(wrapped, "›").map((entry) => entry.value), ["exact-long-payload-without-spaces"]);
});

/** Provides deterministic append-only composer and final submission behavior. */
class ComposerRunner {
  /** Creates an idle target whose optional failed submission leaves exact text staged. */
  constructor(options = {}) {
    this.status = "idle";
    this.stateChangeSeq = 1;
    this.revision = 1;
    this.composer = "";
    this.history = [];
    this.appendedChunks = [];
    this.submittedPayloads = [];
    this.submitCalls = 0;
    this.submitLeavesComposer = options.submitLeavesComposer === true;
    this.detectionHidesHistory = options.detectionHidesHistory === true;
    this.recentHistoryReads = 0;
    this.refreshSnapshot();
  }

  /** Emulates only the Herdr operations used by the composer state machine. */
  async run(args) {
    if (args[0] === "agent" && args[1] === "get") {
      return { agent: { pane_id: args[2], agent_status: this.status, state_change_seq: this.stateChangeSeq, revision: this.revision } };
    }
    if (args[0] === "pane" && args[1] === "send-text") {
      this.appendedChunks.push(args[3]);
      this.composer += args[3];
      this.refreshSnapshot();
      return {};
    }
    if (args[0] === "agent" && args[1] === "send-keys") {
      this.submitCalls += 1;
      if (!this.submitLeavesComposer) {
        this.submittedPayloads.push(this.composer);
        this.history.push(this.composer);
        this.composer = "";
        this.stateChangeSeq += 1;
        this.revision += 1;
      }
      this.refreshSnapshot();
      return {};
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }

  /** Returns the current exact detection snapshot without changing lifecycle state. */
  async runText(args) {
    if (args.includes("recent-unwrapped")) this.recentHistoryReads += 1;
    if (this.detectionHidesHistory && args.includes("detection") && this.composer.length === 0) {
      return "› Ask Codex";
    }
    return this.snapshot;
  }

  /** Rebuilds a minimal detection snapshot with submitted history and current composer. */
  refreshSnapshot() {
    const history = this.history.map((payload) => `› ${payload}\n\n• Message received`).join("\n\n");
    const composer = this.composer.length > 0 ? `› ${this.composer}` : "› Ask Codex";
    const workingFooter = this.status === "working" ? "tab to queue message 97% context left" : "";
    this.snapshot = [history, composer, workingFooter].filter(Boolean).join("\n\n");
  }
}
