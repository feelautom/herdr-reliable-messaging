import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueReliableMessage, enqueueReliableBatch, drainPendingTransactions, processTransactionPath, listDeliveryReceipts, cancelQueueEntry, showReliableBatch, retryQueueEntry } from "../src/service.mjs";
import { readJson, writeJson, transactionPath, acquireStateLock, batchTransactionPath, alertPath } from "../src/storage.mjs";
import { ensureDeliveryAnomalies, listDeliveryAlerts, drainPendingAlerts } from "../src/alerts.mjs";
import { CliHerdrRunner } from "../src/herdr.mjs";
import { runDeliveryDaemon } from "../src/daemon.mjs";
import { setTimeout as delay } from "node:timers/promises";

/** Fixed original admission time; every boundary test derives age without sleeping five minutes. */
const BASE = Date.parse("2030-01-01T00:00:00.000Z");

/** Provides exact independent composers without ever invoking Herdr or the live queue. */
class ExpirationRunner {
  /** Initializes a working target whose hidden receipt reproduces SUBMISSION_UNPROVEN. */
  constructor() {
    this.calls = [];
    this.composer = "";
    this.snapshot = "› Ask Codex";
    this.available = true;
    this.showReceipt = false;
    this.submittedPayloads = [];
  }
  /** Emulates inventory and guarded writes, retaining exact arguments for anti-replay assertions. */
  async run(args) {
    this.calls.push(args);
    if (args[0] === "pane" && args[1] === "list") return { panes: this.available ? [
      { pane_id: "target", label: "TARGET", terminal_id: "terminal", workspace_id: "workspace", tab_id: "tab" },
      { pane_id: "second", label: "SECOND", terminal_id: "second-terminal", workspace_id: "workspace", tab_id: "tab" },
    ] : [] };
    if (args[1] === "get") return { agent: { agent_status: "working", state_change_seq: 10, revision: 10 } };
    if (args[1] === "send-text") { this.composer += args[3]; this.snapshot = `› ${this.composer}`; return {}; }
    if (args[1] === "send-keys") {
      this.submittedPayloads.push(this.composer);
      this.snapshot = this.showReceipt ? `› ${this.composer}\n\n• Received\n\n› Ask Codex` : "› Ask Codex";
      this.composer = "";
      return {};
    }
    throw new Error("Unexpected fake command");
  }
  /** Returns synthetic text only; callers can delay this read to cross the deadline. */
  async runText() { return this.snapshot; }
}

/** Creates one private temporary queue and guarantees cleanup on both assertion outcomes. */
async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-expiration-"));
  try { await callback(directory, new ExpirationRunner()); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

/** Admits a real valid envelope, then pins its original admission time to the simulated clock. */
async function admit(directory, runner, id, overrides = {}) {
  await enqueueReliableMessage(runner, { externalSenderLabel: "EXPIRATION TEST", recipientTitle: "TARGET", body: "PRIVATE exact Ω body", correlationId: id }, { directory });
  const path = transactionPath(directory, id);
  const stored = await readJson(path);
  await writeJson(path, { ...stored, createdAt: new Date(BASE).toISOString(), nextAttemptAt: new Date(BASE).toISOString(), ...overrides });
  runner.calls = [];
  return path;
}

test("expires at exactly five minutes before a future retry or any target call", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "boundary", { code: "SUBMISSION_UNPROVEN", nextAttemptAt: new Date(BASE + 900_000).toISOString() });
    assert.equal((await processTransactionPath(runner, path, { directory, now: BASE + 299_999 })).status, "PENDING");
    const result = await processTransactionPath(runner, path, { directory, now: BASE + 300_000 });
    assert.equal(result.status, "FAILED");
    assert.equal(result.code, "DELIVERY_EXPIRED");
    assert.equal(result.previousCode, "SUBMISSION_UNPROVEN");
    assert.equal(runner.calls.length, 0);
    const stored = await readJson(path);
    assert.equal(Object.hasOwn(stored, "body"), false);
    assert.equal(Object.hasOwn(stored, "nextAttemptAt"), false);
    assert.deepEqual(await processTransactionPath(runner, path, { directory, now: BASE + 900_000 }), result);
  });
});

test("restart expires every old follower before advancing the first fresh message", async () => {
  await fixture(async (directory, runner) => {
    for (const id of ["old-head", "old-follower"]) await admit(directory, runner, id, { nextAttemptAt: new Date(BASE + 900_000).toISOString() });
    await admit(directory, runner, "fresh", { createdAt: new Date(BASE + 299_000).toISOString() });
    const restarted = new ExpirationRunner();
    restarted.showReceipt = true;
    const results = await drainPendingTransactions(restarted, { directory, now: BASE + 300_000 });
    assert.equal(results.filter((entry) => entry.code === "DELIVERY_EXPIRED").length, 2);
    assert.equal(results.find((entry) => entry.correlationId === "fresh").status, "PENDING");
    assert.equal(restarted.calls.filter((args) => args[1] === "send-text").length, 1);
    for (let tick = 1; tick < 10; tick += 1) {
      await drainPendingTransactions(restarted, { directory, now: BASE + 300_000 + tick * 1_000 });
    }
    assert.equal((await readJson(transactionPath(directory, "fresh"))).status, "DELIVERED");
    assert.equal(restarted.submittedPayloads.length, 1);
  });
});

test("expired ambiguous submission reports unknown receipt without replay or sensitive body", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "ambiguous");
    const stored = await readJson(path);
    stored.code = "SUBMISSION_UNPROVEN";
    stored.checkpoint = { ...stored.checkpoint, submissionAttempted: true, submitAttempts: 1, baselineAgentStatus: "working" };
    await writeJson(path, stored);
    await drainPendingTransactions(runner, { directory, now: BASE + 300_001 });
    const [receipt] = await listDeliveryReceipts(runner, undefined, { directory, all: true });
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.receiptOutcome, "UNKNOWN");
    assert.match(receipt.detail, /expired.*unknown/iu);
    assert.equal(JSON.stringify(receipt).includes("PRIVATE"), false);
    assert.equal(runner.calls.length, 0);
  });
});

for (const code of ["TARGET_UNAVAILABLE", "SNAPSHOT_UNAVAILABLE", "TARGET_COMPOSER_OCCUPIED", "APPEND_AMBIGUOUS", "SUBMISSION_UNPROVEN", "BLOCKING_UI", "TARGET_NOT_SETTLED", "QUEUED_FOR_DELIVERY"]) {
  test(`expires ${code} without looking up the target or postponing the admission deadline`, async () => {
    await fixture(async (directory, runner) => {
      const path = await admit(directory, runner, `state-${code}`, { code, updatedAt: new Date(BASE + 299_999).toISOString(), retryCount: 100 });
      runner.available = false;
      const result = await processTransactionPath(runner, path, { directory, now: BASE + 300_000 });
      assert.equal(result.code, "DELIVERY_EXPIRED");
      assert.equal(result.previousCode, code);
      assert.equal(result.expiresAt, new Date(BASE + 300_000).toISOString());
      assert.equal(runner.calls.length, 0);
    });
  });
}

test("preserves expired fragments and third-party text while bounding the blocked follower too", async () => {
  await fixture(async (directory, runner) => {
    const oldPath = await admit(directory, runner, "fragment");
    const old = await readJson(oldPath);
    old.checkpoint.loadedUnits = 10;
    old.checkpoint.appendAttempts = 1;
    await writeJson(oldPath, old);
    const freshPath = await admit(directory, runner, "blocked-fresh", { createdAt: new Date(BASE + 299_000).toISOString() });
    runner.composer = "expired fragment PLUS private user draft";
    runner.snapshot = `› ${runner.composer}`;
    const result = await drainPendingTransactions(runner, { directory, now: BASE + 300_000 });
    assert.equal(result.find((entry) => entry.correlationId === "fragment").composerState, "POSSIBLE_ORPHAN_PRESERVED");
    assert.equal((await readJson(freshPath)).code, "TARGET_COMPOSER_OCCUPIED");
    await drainPendingTransactions(runner, { directory, now: BASE + 599_000 });
    assert.equal((await readJson(freshPath)).code, "DELIVERY_EXPIRED");
    assert.equal(runner.composer, "expired fragment PLUS private user draft");
    assert.equal(runner.calls.some((args) => ["send-text", "send-keys"].includes(args[1])), false);
  });
});

test("expires a stale follower even behind a fresh head with a future retry", async () => {
  await fixture(async (directory, runner) => {
    await admit(directory, runner, "fresh-head", { createdAt: new Date(BASE + 299_000).toISOString(), nextAttemptAt: new Date(BASE + 500_000).toISOString() });
    const path = await admit(directory, runner, "stale-behind-fresh");
    await drainPendingTransactions(runner, { directory, now: BASE + 300_000 });
    assert.equal((await readJson(path)).code, "DELIVERY_EXPIRED");
    assert.equal(runner.calls.length, 0);
  });
});

test("a delayed snapshot crossing expiry cannot append, submit, or claim delivery", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "slow-snapshot");
    let clock = BASE + 299_999;
    runner.runText = async () => { clock = BASE + 300_000; return "› Ask Codex"; };
    const result = await processTransactionPath(runner, path, { directory, clock: () => clock });
    assert.equal(result.code, "DELIVERY_EXPIRED");
    assert.equal(runner.calls.some((args) => ["send-text", "send-keys"].includes(args[1])), false);
  });
});

test("concurrent expiration workers converge on the same scrubbed receipt", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "two-workers");
    const results = await Promise.all([1, 2].map(() => processTransactionPath(runner, path, { directory, now: BASE + 300_000 })));
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].code, "DELIVERY_EXPIRED");
    assert.equal(Object.hasOwn(await readJson(path), "body"), false);
  });
});

test("expiration rereads a cancellation committed while it waits for the transaction lock", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "cancel-wins");
    const release = await acquireStateLock(directory, "transaction:cancel-wins");
    let pending;
    try {
      pending = processTransactionPath(runner, path, { directory, now: BASE + 300_000 });
      const stored = await readJson(path);
      const terminal = { ...stored, status: "CANCELED", code: "CANCELED_BY_OPERATOR" };
      delete terminal.body;
      await writeJson(path, terminal);
    } finally { await release(); }
    const result = await pending;
    assert.equal(result.status, "CANCELED");
    assert.equal(result.code, "CANCELED_BY_OPERATOR");
    assert.equal(runner.calls.length, 0);
  });
});

test("invalid legacy dates fail closed and valid legacy dates retain their original age", async () => {
  await fixture(async (directory, runner) => {
    for (const [id, overrides, expected] of [
      ["missing-date", { createdAt: undefined }, "PENDING_CREATED_AT_INVALID"],
      ["invalid-date", { createdAt: "invalid" }, "PENDING_CREATED_AT_INVALID"],
      ["legacy-old", { version: 3 }, "DELIVERY_EXPIRED"],
      ["legacy-fresh", { version: 3, createdAt: new Date(BASE + 299_000).toISOString() }, "LEGACY_PENDING_UNRESUMABLE"],
    ]) {
      const path = await admit(directory, runner, id, overrides);
      assert.equal((await processTransactionPath(runner, path, { directory, now: BASE + 300_000 })).code, expected);
      assert.equal(Object.hasOwn(await readJson(path), "body"), false);
    }
  });
});

test("expiration creates one bounded body-free alert and does not depend on alert capacity", async () => {
  await fixture(async (directory, runner) => {
    await admit(directory, runner, "alert-expired");
    await drainPendingTransactions(runner, { directory, now: BASE + 300_000 });
    assert.deepEqual(await ensureDeliveryAnomalies({ directory, maximumRecords: 0, now: BASE + 300_000 }), []);
    assert.equal((await readJson(transactionPath(directory, "alert-expired"))).status, "FAILED");
    assert.equal((await ensureDeliveryAnomalies({ directory, now: BASE + 300_000 })).length, 1);
    assert.equal((await ensureDeliveryAnomalies({ directory, now: BASE + 300_001 })).length, 0);
    const alerts = await listDeliveryAlerts(undefined, { directory, all: true });
    assert.equal(alerts[0].sourceCode, "DELIVERY_EXPIRED");
    assert.equal(JSON.stringify(alerts).includes("PRIVATE"), false);
  });
});

test("expiration alerts display unknown reception and preserved fragments without the body", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "ambiguous-alert");
    const stored = await readJson(path);
    await writeJson(path, { ...stored, sender: { ...stored.recipient, kind: "pane" }, checkpoint: {
      ...stored.checkpoint, submissionAttempted: true, submitAttempts: 1,
    } });
    await processTransactionPath(runner, path, { directory, now: BASE + 300_000 });
    await ensureDeliveryAnomalies({ directory, now: BASE + 300_000 });
    await drainPendingAlerts(runner, { directory, now: BASE + 300_000 });
    const [alert] = await listDeliveryAlerts(undefined, { directory, all: true });
    assert.equal(alert.receiptOutcome, "UNKNOWN");
    assert.equal(alert.composerState, "POSSIBLE_ORPHAN_PRESERVED");
    assert.match(runner.composer, /receipt outcome unknown after submission/u);
    assert.match(runner.composer, /Possible composer fragment preserved/u);
    assert.equal(runner.composer.includes("PRIVATE"), false);
  });
});

test("batch receipts preserve a delivered child while expiring another destination", async () => {
  await fixture(async (directory, runner) => {
    const batch = await enqueueReliableBatch(runner, { externalSenderLabel: "EXPIRATION TEST", recipientTitles: ["TARGET", "SECOND"], body: "PRIVATE batch", batchCorrelationId: "partial" }, { directory });
    const first = batch.results[0];
    const second = batch.results[1];
    const firstPath = batchTransactionPath(directory, "partial", first.correlationId);
    const secondPath = batchTransactionPath(directory, "partial", second.correlationId);
    const delivered = { ...await readJson(firstPath), status: "DELIVERED", code: "DELIVERY_CONFIRMED" };
    delete delivered.body;
    await writeJson(firstPath, delivered);
    await writeJson(secondPath, { ...await readJson(secondPath), createdAt: new Date(BASE).toISOString(), nextAttemptAt: new Date(BASE + 900_000).toISOString() });
    runner.calls = [];
    await drainPendingTransactions(runner, { directory, now: BASE + 300_000 });
    const result = await showReliableBatch("partial", { directory });
    assert.equal(result.status, "MIXED");
    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.pending, 0);
    assert.equal(result.results[1].code, "DELIVERY_EXPIRED");
    assert.deepEqual(await readJson(firstPath), delivered);
    assert.equal(runner.calls.length, 0);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  });
});

test("retry and cancel racing expiration never restore an expired body or refresh admission", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "control-race");
    const outcomes = await Promise.allSettled([
      processTransactionPath(runner, path, { directory, now: BASE + 300_000 }),
      retryQueueEntry(runner, undefined, "control-race", { directory }),
      cancelQueueEntry(runner, undefined, "control-race", { directory }),
    ]);
    assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"));
    const stored = await readJson(path);
    assert.ok(["FAILED", "CANCELED"].includes(stored.status));
    assert.equal(stored.createdAt, new Date(BASE).toISOString());
    assert.equal(Object.hasOwn(stored, "body"), false);
    assert.equal(runner.calls.length, 0);
  });
});

test("a receipt appearing only after expiry never becomes DELIVERED", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "late-proof");
    const stored = await readJson(path);
    await writeJson(path, { ...stored, code: "SECOND_DELIVERY_OBSERVATION_REQUIRED", checkpoint: {
      ...stored.checkpoint, submissionAttempted: true, submitAttempts: 1, proofObservations: 1,
      baselineAgentStatus: "idle", baselineRevision: 1,
    } });
    let clock = BASE + 299_999;
    runner.runText = async () => { clock = BASE + 300_000; return "› Ask Codex"; };
    const result = await processTransactionPath(runner, path, { directory, clock: () => clock });
    assert.equal(result.code, "DELIVERY_EXPIRED");
    assert.equal(result.receiptOutcome, "UNKNOWN");
    assert.equal(runner.calls.some((args) => args[1] === "send-keys"), false);
  });
});

test("production runner bounds both structured and text subprocesses by the supplied timeout", async () => {
  // Invoke only a synthetic Node child; the real Herdr daemon and queue are never involved.
  const runner = new CliHerdrRunner(process.execPath);
  for (const method of ["run", "runText"]) {
    await assert.rejects(runner[method](["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 30 }), (error) => error.code === "herdr_command_failed");
  }
});

test("every Herdr operation receives only the remaining original lifetime", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "remaining-budget");
    const budgets = [];
    const originalRun = runner.run.bind(runner);
    const originalRead = runner.runText.bind(runner);
    runner.run = async (args, options) => { budgets.push(options.timeoutMs); return originalRun(args); };
    runner.runText = async (args, options) => { budgets.push(options.timeoutMs); return originalRead(args); };
    await processTransactionPath(runner, path, { directory, now: BASE + 299_990 });
    assert.ok(budgets.length > 0);
    assert.ok(budgets.every((budget) => budget === 10));
  });
});

for (const stage of ["target", "snapshot", "append", "submit"]) {
  test(`a nonreturning ${stage} subprocess is bounded and preserves the ambiguous checkpoint`, async () => {
    await fixture(async (directory, runner) => {
      const path = await admit(directory, runner, `hung-${stage}`);
      const stored = await readJson(path);
      if (stage === "submit") {
        // Two observations of a fully staged payload normally authorize Enter; the
        // synthetic command then hangs instead of proving what happened to that write.
        runner.composer = `[EXTERNAL EXPIRATION TEST:TARGET] ${stored.body}`;
        runner.snapshot = `› ${runner.composer}`;
        await writeJson(path, { ...stored, checkpoint: { ...stored.checkpoint, loadedUnits: runner.composer.length, loadedChunks: 1, readyObservations: 1 } });
      }
      let clock = BASE + 299_900;
      const subprocess = new CliHerdrRunner(process.execPath);
      const originalRun = runner.run.bind(runner);
      const originalRead = runner.runText.bind(runner);
      const timeouts = [];
      /** Uses the actual production subprocess timeout without touching Herdr. */
      const hang = async (options) => {
        timeouts.push(options.timeoutMs);
        try { return await subprocess.runText(["-e", "setTimeout(() => {}, 10000)"], options); }
        finally { clock = BASE + 300_000; }
      };
      runner.run = async (args, options) => {
        if ((stage === "target" && args[1] === "list") || (stage === "append" && args[1] === "send-text") || (stage === "submit" && args[1] === "send-keys")) return hang(options);
        return originalRun(args);
      };
      runner.runText = async (args, options) => stage === "snapshot" ? hang(options) : originalRead(args);
      const result = await processTransactionPath(runner, path, { directory, clock: () => clock });
      assert.deepEqual(timeouts, [100]);
      assert.equal(result.code, "DELIVERY_EXPIRED");
      const terminal = await readJson(path);
      assert.equal(Object.hasOwn(terminal, "body"), false);
      if (stage === "append") {
        assert.ok(terminal.checkpoint.pendingAppendEnd > 0);
        assert.equal(terminal.checkpoint.appendAttempts, 1);
        assert.equal(result.composerState, "POSSIBLE_ORPHAN_PRESERVED");
      }
      if (stage === "submit") {
        assert.equal(terminal.checkpoint.submissionAttempted, true);
        assert.equal(terminal.checkpoint.submitAttempts, 1);
        assert.equal(result.receiptOutcome, "UNKNOWN");
      }
    });
  });
}

test("a hanging alert cannot prevent subsequent daemon scans from expiring data", async () => {
  await fixture(async (directory, runner) => {
    const path = await admit(directory, runner, "daemon-expiry", { nextAttemptAt: new Date(BASE + 900_000).toISOString() });
    const sourcePath = await admit(directory, runner, "daemon-alert-source");
    const source = await readJson(sourcePath);
    const failed = { ...source, status: "FAILED", code: "TEST_FAILURE", sender: { ...source.recipient, kind: "pane" } };
    delete failed.body;
    await writeJson(sourcePath, failed);
    await ensureDeliveryAnomalies({ directory, now: Date.now() });
    let now = BASE + 299_999;
    let enterAlert;
    const entered = new Promise((resolve) => { enterAlert = resolve; });
    const subprocess = new CliHerdrRunner(process.execPath);
    runner.runText = async (args, options) => {
      enterAlert();
      // An emergency test-only timeout bounds the unfixed RED scenario as well.
      return subprocess.runText(["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: options?.timeoutMs ?? 2000 });
    };
    const controller = new AbortController();
    const daemon = runDeliveryDaemon(runner, directory, { runtime: { instanceId: "synthetic-only" } }, {
      signal: controller.signal, pollIntervalMs: 10, alertDrainBudgetMs: 25, clock: () => now,
    });
    let expired = false;
    try {
      await entered;
      now = BASE + 300_001;
      const observationDeadline = Date.now() + 1_000;
      while (Date.now() < observationDeadline) {
        if ((await readJson(path)).code === "DELIVERY_EXPIRED") { expired = true; break; }
        await delay(20);
      }
    } finally {
      controller.abort();
      await daemon;
    }
    assert.equal(expired, true, "Data expiry must progress before the emergency alert timeout releases the unfixed loop");
    assert.equal(Object.hasOwn(await readJson(path), "body"), false);
  });
});

for (const stage of ["append", "submit"]) {
  test(`alert ${stage} timeout preserves durable intent and never blindly replays on the next scan`, async () => {
    await fixture(async (directory, runner) => {
      const sourcePath = await admit(directory, runner, `control-${stage}`);
      const source = await readJson(sourcePath);
      const failed = { ...source, status: "FAILED", code: "TEST_FAILURE", sender: { ...source.recipient, kind: "pane" } };
      delete failed.body;
      await writeJson(sourcePath, failed);
      const now = Date.now() + 60_000;
      await ensureDeliveryAnomalies({ directory, now });
      if (stage === "submit") {
        for (let tick = 0; tick < 3; tick += 1) await drainPendingAlerts(runner, { directory, now: now + tick * 1000 });
      }
      const originalRun = runner.run.bind(runner);
      const subprocess = new CliHerdrRunner(process.execPath);
      let attempts = 0;
      let intendedText;
      runner.run = async (args, options) => {
        if (args[1] === (stage === "append" ? "send-text" : "send-keys")) {
          attempts += 1;
          intendedText = stage === "append" ? args[3] : runner.composer;
          return subprocess.run(["-e", "setTimeout(() => {}, 10000)"], options);
        }
        return originalRun(args);
      };
      await drainPendingAlerts(runner, { directory, now: now + 3000, drainBudgetMs: 100 });
      const path = alertPath(directory, `control-${stage}:TEST_FAILURE`);
      const waiting = await readJson(path);
      assert.equal(waiting.status, "PENDING");
      assert.equal(attempts, 1);
      if (stage === "append") {
        assert.ok(waiting.checkpoint.pendingAppendEnd > 0);
        assert.equal(waiting.checkpoint.appendAttempts, 1);
        runner.composer = intendedText;
        runner.snapshot = `› ${intendedText}`;
      } else {
        assert.equal(waiting.checkpoint.submissionAttempted, true);
        assert.equal(waiting.checkpoint.submitAttempts, 1);
        runner.composer = "";
        runner.snapshot = "› Ask Codex";
      }
      runner.run = originalRun;
      runner.calls = [];
      await drainPendingAlerts(runner, { directory, now: now + 5000 });
      assert.equal(runner.calls.some((args) => ["send-text", "send-keys"].includes(args[1])), false);
      assert.equal((await readJson(path)).status, "PENDING");
    });
  });
}
