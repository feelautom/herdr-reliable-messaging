import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainPendingAlerts, ensureDeliveryAnomalies, listDeliveryAlerts, pruneTerminalAlerts } from "../src/alerts.mjs";
import { initialComposerCheckpoint } from "../src/delivery.mjs";
import { alertPath, readJson, transactionPath, writeJson } from "../src/storage.mjs";

/** Proves failed data delivery creates only one body-free control record. */
test("deduplicates failed-delivery alerts outside the data FIFO", async () => {
  await withDirectory(async (directory) => {
    await writeFailedTransaction(directory, "failed-message");
    assert.equal((await ensureDeliveryAnomalies({ directory })).length, 1);
    assert.equal((await ensureDeliveryAnomalies({ directory })).length, 0);
    const alerts = await listDeliveryAlerts("sender-pane", { directory });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].anomalyCode, "FAILED_AMBIGUOUS_APPEND_LOST");
    assert.equal(JSON.stringify(alerts).includes("PRIVATE BODY"), false);
  });
});

/** Proves the separate control channel safely presents one alert and never a success notice. */
test("delivers one deferred body-free anomaly to the sender pane", async () => {
  await withDirectory(async (directory) => {
    await writeFailedTransaction(directory, "failed-presented");
    await ensureDeliveryAnomalies({ directory });
    const runner = new AlertRunner();
    const base = Date.now() + 60_000;
    for (let tick = 0; tick < 40; tick += 1) {
      await drainPendingAlerts(runner, { directory, now: base + tick * 1_000 });
      const [alert] = await listDeliveryAlerts("sender-pane", { directory });
      if (alert.status === "DELIVERED") break;
    }
    const [alert] = await listDeliveryAlerts("sender-pane", { directory });
    assert.equal(alert.status, "DELIVERED");
    assert.equal(runner.submitCalls, 1);
    assert.match(runner.submittedPayloads[0], /^\[EXTERNAL HERDR RELIABLE MESSAGING:SENDER PANE\] Delivery problem/u);
    assert.match(runner.submittedPayloads[0], /failed-presented/u);
    assert.equal(runner.submittedPayloads[0].includes("PRIVATE BODY"), false);
  });
});

test("retains the former envelope when resuming a version-one control alert", async () => {
  await withDirectory(async (directory) => {
    await writeFailedTransaction(directory, "legacy-alert-source");
    await ensureDeliveryAnomalies({ directory });
    const path = alertPath(directory, "legacy-alert-source:FAILED_AMBIGUOUS_APPEND_LOST");
    const stored = await readJson(path, undefined);
    stored.version = 1;
    await writeJson(path, stored);

    const runner = new AlertRunner();
    const base = Date.now() + 60_000;
    for (let tick = 0; tick < 40; tick += 1) {
      await drainPendingAlerts(runner, { directory, now: base + tick * 1_000 });
      const [alert] = await listDeliveryAlerts("sender-pane", { directory });
      if (alert.status === "DELIVERED") break;
    }
    assert.match(runner.submittedPayloads[0], /^EXTERNAL HERDR RELIABLE MESSAGING \| SENDER PANE : Delivery problem/u);
  });
});

/** Proves success and pre-feature history never generate unsolicited control messages. */
test("does not alert for successful or historical transactions", async () => {
  await withDirectory(async (directory) => {
    const now = new Date().toISOString();
    await writeJson(transactionPath(directory, "delivered-success"), {
      correlationId: "delivered-success",
      createdAt: now,
      updatedAt: now,
      status: "DELIVERED",
      code: "DELIVERY_CONFIRMED",
      alertPolicy: "sender-notify-v1",
    });
    await writeJson(transactionPath(directory, "historical-failure"), {
      correlationId: "historical-failure",
      createdAt: now,
      updatedAt: now,
      status: "FAILED",
      code: "HISTORICAL_FAILURE",
    });
    assert.deepEqual(await ensureDeliveryAnomalies({ directory }), []);
    assert.deepEqual(await listDeliveryAlerts(undefined, { directory, all: true }), []);
  });
});

/** Proves a recovered stuck message cancels its pending notice before presentation. */
test("cancels a stale stuck alert when delivery recovers before notification", async () => {
  await withDirectory(async (directory) => {
    const createdAt = new Date(0).toISOString();
    const path = transactionPath(directory, "stuck-recovered");
    await writeJson(path, {
      version: 4,
      correlationId: "stuck-recovered",
      queueSequence: 1,
      createdAt,
      updatedAt: createdAt,
      status: "PENDING",
      code: "TARGET_UNAVAILABLE",
      alertPolicy: "sender-notify-v1",
      sender: { kind: "pane", paneId: "sender-pane", terminalId: "sender-terminal", workspaceId: "workspace", tabId: "tab", title: "SENDER PANE" },
      recipient: { title: "MISSING" },
      checkpoint: initialComposerCheckpoint(),
    });
    await ensureDeliveryAnomalies({ directory, now: 120_000, pendingAgeMs: 60_000 });
    await writeJson(path, { ...(await readJson(path, undefined)), status: "DELIVERED", code: "DELIVERY_CONFIRMED" });
    const runner = new AlertRunner();
    await drainPendingAlerts(runner, { directory, now: 121_000 });
    const [alert] = await listDeliveryAlerts("sender-pane", { directory });
    assert.equal(alert.status, "CANCELED");
    assert.equal(alert.code, "ANOMALY_RECOVERED_BEFORE_NOTICE");
    assert.equal(runner.submitCalls, 0);
  });
});

/** Proves terminal control proofs are bounded without deleting an active sender notice. */
test("prunes only terminal anomaly records outside retention bounds", async () => {
  await withDirectory(async (directory) => {
    const old = new Date(0).toISOString();
    await writeJson(alertPath(directory, "old-terminal"), { alertId: "old-terminal", status: "DELIVERED", updatedAt: old });
    await writeJson(alertPath(directory, "active"), { alertId: "active", status: "PENDING", updatedAt: old });
    assert.equal(await pruneTerminalAlerts(directory, { retentionMs: 1, maximumTerminal: 10 }), 1);
    assert.equal(await readJson(alertPath(directory, "old-terminal"), undefined), undefined);
    assert.equal((await readJson(alertPath(directory, "active"), undefined)).status, "PENDING");
  });
});

/** Proves an unavailable sender cannot grow the best-effort control inbox without bound. */
test("caps anomaly records while preserving source transaction receipts", async () => {
  await withDirectory(async (directory) => {
    await writeJson(alertPath(directory, "existing-active"), { alertId: "existing-active", status: "PENDING" });
    await writeFailedTransaction(directory, "failure-beyond-cap");
    assert.deepEqual(await ensureDeliveryAnomalies({ directory, maximumRecords: 1 }), []);
    assert.equal((await listDeliveryAlerts(undefined, { directory, all: true })).length, 1);
    assert.equal((await readJson(transactionPath(directory, "failure-beyond-cap"), undefined)).status, "FAILED");
  });
});

/**
 * Writes one opted-in failed transaction containing only representative body-free proof.
 * The exact correlation controls its traversal-safe path; the helper persists no source body.
 */
async function writeFailedTransaction(directory, correlationId) {
  const now = new Date().toISOString();
  await writeJson(transactionPath(directory, correlationId), {
    version: 4,
    correlationId,
    queueSequence: 1,
    createdAt: now,
    updatedAt: now,
    status: "FAILED",
    code: "FAILED_AMBIGUOUS_APPEND_LOST",
    alertPolicy: "sender-notify-v1",
    sender: { kind: "pane", paneId: "sender-pane", terminalId: "sender-terminal", workspaceId: "workspace", tabId: "tab", title: "SENDER PANE" },
    recipient: { title: "REVIEWER" },
    messageHash: "PRIVATE BODY HASH ONLY",
    messageLength: 12,
    checkpoint: initialComposerCheckpoint(),
  });
}

/**
 * Emulates one pinned sender pane, exact composer, and causal receipt sequence.
 * All mutations are in-memory and submission payloads remain inspectable for body-leak and
 * duplicate-send assertions.
 */
class AlertRunner {
  /**
   * Initializes one empty composer plus deterministic lifecycle and revision counters.
   * The pane begins idle and no submit evidence exists until the control dispatcher acts.
   */
  constructor() {
    this.composer = "";
    this.snapshot = "› Ask Codex";
    this.stateChangeSeq = 1;
    this.revision = 1;
    this.agentStatus = "idle";
    this.postSubmitReads = 0;
    this.submitCalls = 0;
    this.submittedPayloads = [];
  }

  /**
   * Emulates identity, lifecycle, exact append, and submit operations for the sender pane.
   * Submission clears the composer once and exposes delayed idle evidence; unsupported commands
   * fail immediately so a changed production protocol cannot pass silently.
   */
  async run(args) {
    if (args[0] === "pane" && args[1] === "list") return { panes: [{ pane_id: "sender-pane", terminal_id: "sender-terminal", workspace_id: "workspace", tab_id: "tab", label: "SENDER PANE", agent_status: this.agentStatus }] };
    if (args[0] === "agent" && args[1] === "get") {
      if (this.postSubmitReads > 0) {
        this.postSubmitReads += 1;
        if (this.postSubmitReads >= 3) this.agentStatus = "idle";
      }
      return { agent: { agent: "codex", pane_id: "sender-pane", agent_status: this.agentStatus, state_change_seq: this.stateChangeSeq, revision: this.revision } };
    }
    if (args[0] === "pane" && args[1] === "send-text") {
      this.composer += args[3];
      this.snapshot = `› ${this.composer}`;
      return { agent: {} };
    }
    if (args[0] === "agent" && args[1] === "send-keys") {
      this.submitCalls += 1;
      this.submittedPayloads.push(this.composer);
      const submitted = this.composer;
      this.composer = "";
      this.stateChangeSeq += 1;
      this.revision += 1;
      this.agentStatus = "working";
      this.postSubmitReads = 1;
      this.snapshot = `› ${submitted}\n\n• Alert received\n\n› Ask Codex`;
      return { agent: {} };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }

  /**
   * Returns the current bounded detection snapshot without changing fake state.
   * The snapshot is the sole transcript/composer evidence consumed by delivery verification.
   */
  async runText() {
    return this.snapshot;
  }
}

/**
 * Runs one alert scenario in a fresh OS temporary directory and always removes it afterward.
 * Callback failures propagate after cleanup, preventing test artifacts from accumulating.
 */
async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-alerts-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
