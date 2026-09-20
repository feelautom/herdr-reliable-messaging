import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelQueueEntry,
  drainPendingTransactions,
  enqueueReliableBatch,
  enqueueReliableMessage,
  getServiceStatus,
  listDeliveryReceipts,
  listReliableBatches,
  listQueueEntries,
  processTransactionPath,
  purgeQueueProofs,
  retryQueueEntry,
  showQueueEntry,
  showReliableBatch,
} from "../src/service.mjs";
import { fingerprint, readJson, transactionPath, writeJson } from "../src/storage.mjs";

const SENDER_TITLE = "AUTHOR";
const RECIPIENT_TITLE = "REVIEWER";

test("discards a self-addressed pane message without creating queue state", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    const discarded = await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: SENDER_TITLE,
      body: "This message must never enter the dispatcher queue.",
      correlationId: "self-message",
    }, { directory });

    assert.equal(discarded.status, "DISCARDED");
    assert.equal(discarded.code, "SELF_MESSAGE_DISCARDED");
    assert.equal((await listQueueEntries(runner, "sender-pane", { directory, includeTerminal: true })).length, 0);
    assert.equal(await readJson(transactionPath(directory, "self-message"), undefined), undefined);
    assert.equal(runner.appendedChunks.length, 0);
    assert.equal(runner.submitCalls, 0);
  });
});

test("one durable acceptance loads a long composer in chunks and submits once", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    const body = "Transmission autonome exacte. ".repeat(36);
    assert.ok(body.length >= 1_000);

    const accepted = await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body,
      correlationId: "multipart-autonomous",
    }, { directory });
    assert.equal(accepted.status, "ACCEPTED");
    assert.ok(accepted.totalChunks > 1);

    const delivered = await drainUntilTerminal(runner, directory, "multipart-autonomous");
    assert.equal(delivered.status, "DELIVERED");
    assert.equal(runner.submitCalls, 1);
    assert.equal(runner.submittedPayloads.length, 1);
    assert.equal(runner.appendedChunks.join(""), runner.submittedPayloads[0]);
    assert.ok(runner.appendedChunks.every((chunk) => chunk.length <= 500));

    const stored = await readJson(transactionPath(directory, "multipart-autonomous"), undefined);
    assert.equal(stored.status, "DELIVERED");
    assert.equal(Object.hasOwn(stored, "body"), false);
    assert.equal(stored.checkpoint.loadedChunks, accepted.totalChunks);
  });
});

test("accepts an unavailable exact target and safely pins it before first injection", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner({ recipientAvailable: false });
    const accepted = await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "Message retained until the destination appears.",
      correlationId: "late-target",
    }, { directory });
    assert.equal(accepted.status, "ACCEPTED");
    assert.equal(runner.submittedPayloads.length, 0);

    runner.recipientAvailable = true;
    const delivered = await drainUntilTerminal(runner, directory, "late-target");
    assert.equal(delivered.status, "DELIVERED");
    assert.equal(runner.submittedPayloads.length, 1);
  });
});

/** Proves one batch publishes independent durable children with deterministic correlations. */
test("atomically admits one exact body for three independent recipients", async () => {
  await withDirectory(async (directory) => {
    const runner = new MultiTargetRunner();
    const accepted = await enqueueReliableBatch(runner, {
      senderPaneId: "sender-pane",
      recipientTitles: ["TARGET A", "TARGET B", "TARGET C"],
      body: "One exact body for every target.",
      batchCorrelationId: "batch-three",
    }, { directory });

    assert.equal(accepted.status, "ACCEPTED");
    assert.equal(accepted.total, 3);
    assert.equal(new Set(accepted.results.map(({ correlationId }) => correlationId)).size, 3);
    assert.deepEqual(accepted.results.map(({ queueSequence }) => queueSequence), [1, 2, 3]);
    assert.ok(accepted.results.every((result) => !Object.hasOwn(result, "body")));

    const replay = await enqueueReliableBatch(runner, {
      senderPaneId: "sender-pane",
      recipientTitles: ["TARGET A", "TARGET B", "TARGET C"],
      body: "One exact body for every target.",
      batchCorrelationId: "batch-three",
    }, { directory });
    assert.equal(replay.code, "ALREADY_ACCEPTED");
    assert.deepEqual(replay.results.map(({ correlationId }) => correlationId), accepted.results.map(({ correlationId }) => correlationId));

    const stored = await showReliableBatch("batch-three", { directory });
    assert.equal(stored.pending, 3);
    assert.ok(stored.results.every((result) => !Object.hasOwn(result, "body")));
    assert.equal((await listQueueEntries(runner, "sender-pane", { directory })).length, 3);
    const receipts = await listReliableBatches("sender-pane", { directory });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].batchCorrelationId, "batch-three");
    assert.ok(receipts[0].results.every((result) => !Object.hasOwn(result, "body")));
  });
});

/** Proves batch validation rejects the whole request before any child is published. */
test("rejects duplicate, absent, and ambiguous batch targets without partial admission", async () => {
  await withDirectory(async (directory) => {
    const runner = new MultiTargetRunner({ duplicateTitle: "TARGET B" });
    const cases = [
      { titles: ["TARGET A", "TARGET A"], code: "DUPLICATE_TARGET" },
      { titles: ["TARGET A", "MISSING"], code: "TARGET_UNAVAILABLE" },
      { titles: ["TARGET A", "TARGET B"], code: "TARGET_AMBIGUOUS" },
    ];
    for (const [index, scenario] of cases.entries()) {
      await assert.rejects(
        enqueueReliableBatch(runner, {
          senderPaneId: "sender-pane",
          recipientTitles: scenario.titles,
          body: "Must not be partially admitted.",
          batchCorrelationId: `batch-reject-${index}`,
        }, { directory }),
        (error) => error.code === scenario.code,
      );
      assert.equal((await listQueueEntries(runner, "sender-pane", { directory, includeTerminal: true })).length, 0);
    }
  });
});

/** Proves a duplicate live title returns exact candidates instead of poisoning a single FIFO lane. */
test("rejects an ambiguous single target with body-free rename suggestions", async () => {
  await withDirectory(async (directory) => {
    const runner = new MultiTargetRunner({ duplicateTitle: "TARGET B" });
    await assert.rejects(
      enqueueReliableMessage(runner, {
        senderPaneId: "sender-pane",
        recipientTitle: "TARGET B",
        body: "Must not be queued ambiguously.",
        correlationId: "single-ambiguous",
      }, { directory }),
      (error) => error.code === "TARGET_AMBIGUOUS" && error.details.candidates.length === 2 &&
        error.details.suggestedRenames.every((suggestion) => suggestion.suggestedTitle.includes(suggestion.paneId)),
    );
    assert.equal((await listQueueEntries(runner, "sender-pane", { directory, includeTerminal: true })).length, 0);
  });
});

/** Proves single, batch, and derived child correlations share one collision-free namespace. */
test("rejects correlation reuse across single, batch, and batch-child records", async () => {
  await withDirectory(async (directory) => {
    const runner = new MultiTargetRunner();
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: "TARGET A",
      body: "single",
      correlationId: "shared-correlation",
    }, { directory });
    await assert.rejects(
      enqueueReliableBatch(runner, {
        senderPaneId: "sender-pane",
        recipientTitles: ["TARGET A", "TARGET B"],
        body: "batch",
        batchCorrelationId: "shared-correlation",
      }, { directory }),
      (error) => error.code === "BATCH_CORRELATION_CONFLICT",
    );

    const accepted = await enqueueReliableBatch(runner, {
      senderPaneId: "sender-pane",
      recipientTitles: ["TARGET B", "TARGET C"],
      body: "batch child namespace",
      batchCorrelationId: "batch-namespace",
    }, { directory });
    await assert.rejects(
      enqueueReliableMessage(runner, {
        senderPaneId: "sender-pane",
        recipientTitle: "TARGET A",
        body: "collision",
        correlationId: accepted.results[0].correlationId,
      }, { directory }),
      (error) => error.code === "CORRELATION_CONFLICT",
    );
    await assert.rejects(
      enqueueReliableMessage(runner, {
        senderPaneId: "sender-pane",
        recipientTitle: "TARGET A",
        body: "collision",
        correlationId: "batch-namespace",
      }, { directory }),
      (error) => error.code === "CORRELATION_CONFLICT",
    );
  });
});

/** Proves one blocked child cannot stall other destinations and every child submits once. */
test("preserves independent batch progress and per-destination FIFO state", async () => {
  await withDirectory(async (directory) => {
    const runner = new MultiTargetRunner({ blockedTitle: "TARGET B" });
    await enqueueReliableBatch(runner, {
      senderPaneId: "sender-pane",
      recipientTitles: ["TARGET A", "TARGET B", "TARGET C"],
      body: "Independent batch delivery.",
      batchCorrelationId: "batch-independent",
    }, { directory });

    const base = Date.now() + 60_000;
    for (let tick = 0; tick < 30; tick += 1) {
      await drainPendingTransactions(runner, { directory, now: base + tick * 1_000, recipientConcurrency: 3 });
    }
    const partial = await showReliableBatch("batch-independent", { directory });
    assert.equal(partial.delivered, 2);
    assert.equal(partial.pending, 1);
    assert.equal(runner.submittedPayloads.get("recipient-A").length, 1);
    assert.equal(runner.submittedPayloads.get("recipient-C").length, 1);
    assert.equal(runner.submittedPayloads.get("recipient-B").length, 0);

    runner.blockedTitle = undefined;
    for (let tick = 30; tick < 60; tick += 1) {
      await drainPendingTransactions(runner, { directory, now: base + tick * 1_000, recipientConcurrency: 3 });
    }
    const complete = await showReliableBatch("batch-independent", { directory });
    assert.equal(complete.status, "DELIVERED");
    assert.equal(complete.delivered, 3);
    assert.ok([...runner.submittedPayloads.values()].every((payloads) => payloads.length === 1));
  });
});

/** Proves local queue controls ignore pane roles without weakening body scrubbing or checkpoints. */
test("queue controls are role-neutral, body-scoped, checkpoint-safe, and purge only terminal proof", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "Temporary private content",
      correlationId: "queue-controls",
    }, { directory });

    const listed = await listQueueEntries(runner, "sender-pane", { directory });
    assert.equal(listed.length, 1);
    assert.equal(Object.hasOwn(listed[0], "body"), false);
    assert.equal((await showQueueEntry(runner, "sender-pane", "queue-controls", { directory })).body, "Temporary private content");

    const path = transactionPath(directory, "queue-controls");
    const injected = await readJson(path, undefined);
    injected.checkpoint.loadedUnits = 1;
    injected.checkpoint.submitAttempts = 1;
    await writeJson(path, injected);

    await retryQueueEntry(runner, "sender-pane", "queue-controls", { directory });
    const retried = await readJson(path, undefined);
    assert.equal(retried.checkpoint.loadedUnits, 1);
    assert.equal(retried.checkpoint.submitAttempts, 1);

    const canceled = await cancelQueueEntry(runner, "sender-pane", "queue-controls", { directory });
    assert.equal(canceled.status, "CANCELED");
    assert.equal(canceled.code, "CANCELED_AMBIGUOUS");
    assert.equal(Object.hasOwn(await readJson(path, undefined), "body"), false);

    runner.senderTitle = "RUNNER";
    assert.equal((await listQueueEntries(runner, "sender-pane", { directory, includeTerminal: true })).length, 1);
    assert.deepEqual(await purgeQueueProofs(runner, "sender-pane", { directory }), { removed: 1 });
    assert.equal(await readJson(path, undefined), undefined);
  });
});

/** Proves one worker-originated transaction is accepted and delivered with its exact live title. */
test("accepts a worker sender and delivers its exact visible pane title", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    runner.senderTitle = "RUNNER";
    const accepted = await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "Universal report from a runner.",
      correlationId: "worker-universal",
    }, { directory });
    assert.equal(accepted.senderTitle, "RUNNER");
    const delivered = await drainUntilTerminal(runner, directory, "worker-universal");
    assert.equal(delivered.status, "DELIVERED");
    assert.equal(runner.submittedPayloads[0], "[RUNNER:REVIEWER] Universal report from a runner.");
  });
});

/** Proves external acceptance, exact attribution, correlation isolation, and terminal delivery. */
test("accepts an external sender without HERDR_PANE_ID and preserves its explicit label", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    const accepted = await enqueueReliableMessage(runner, {
      externalSenderLabel: "LOCAL AUTOMATION",
      recipientTitle: RECIPIENT_TITLE,
      body: "Message from a process outside Herdr.",
      correlationId: "external-universal",
    }, { directory });
    assert.equal(accepted.senderTitle, "EXTERNAL LOCAL AUTOMATION");
    await assert.rejects(
      enqueueReliableMessage(runner, {
        externalSenderLabel: "OTHER SESSION",
        recipientTitle: RECIPIENT_TITLE,
        body: "Message from a process outside Herdr.",
        correlationId: "external-universal",
      }, { directory }),
      (error) => error.code === "CORRELATION_CONFLICT",
    );
    const delivered = await drainUntilTerminal(runner, directory, "external-universal");
    assert.equal(delivered.status, "DELIVERED");
    assert.equal(runner.submittedPayloads[0], "[EXTERNAL LOCAL AUTOMATION:REVIEWER] Message from a process outside Herdr.");
  });
});

test("lists the 50 newest body-free receipts for the exact calling pane", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    for (let index = 0; index < 55; index += 1) {
      await enqueueReliableMessage(runner, {
        senderPaneId: "sender-pane",
        recipientTitle: `TARGET ${index}`,
        body: `private body ${index}`,
        correlationId: `receipt-own-${String(index).padStart(2, "0")}`,
      }, { directory });
    }
    runner.otherSenderTitle = "OTHER EXACT SENDER";
    await enqueueReliableMessage(runner, {
      senderPaneId: "other-pane",
      recipientTitle: "OTHER TARGET",
      body: "other private body",
      correlationId: "receipt-other",
    }, { directory });

    const receipts = await listDeliveryReceipts(runner, "sender-pane", { directory });
    assert.equal(receipts.length, 50);
    assert.equal(receipts[0].correlationId, "receipt-own-54");
    assert.equal(receipts.at(-1).correlationId, "receipt-own-05");
    assert.ok(receipts.every((receipt) => receipt.senderPaneId === "sender-pane"));
    assert.ok(receipts.every((receipt) => Object.hasOwn(receipt, "detail")));
    assert.ok(receipts.every((receipt) => !Object.hasOwn(receipt, "body")));

    const globalReceipts = await listDeliveryReceipts(runner, undefined, { directory, all: true });
    assert.equal(globalReceipts.length, 50);
    assert.equal(globalReceipts[0].correlationId, "receipt-other");
    assert.ok(globalReceipts.every((receipt) => !Object.hasOwn(receipt, "body")));
  });
});

test("requires an exact calling pane for sender-scoped receipts", async () => {
  await withDirectory(async (directory) => {
    await assert.rejects(
      listDeliveryReceipts(new ServiceRunner(), undefined, { directory }),
      (error) => error.code === "SOURCE_UNAVAILABLE",
    );
  });
});

test("fails legacy pending records closed and scrubs any unexpected body", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    const path = transactionPath(directory, "legacy-pending");
    await writeJson(path, {
      version: 1,
      correlationId: "legacy-pending",
      status: "PENDING",
      body: "must not survive",
      sender: { title: SENDER_TITLE },
      recipient: { title: RECIPIENT_TITLE },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    // Keep this protocol-compatibility check inside the admission lifetime; expired
    // legacy entries have their own higher-priority expiration regression coverage.
    const result = await processTransactionPath(runner, path, { directory, now: 1 });
    assert.equal(result.status, "FAILED");
    assert.equal(result.code, "LEGACY_PENDING_UNRESUMABLE");
    assert.equal(Object.hasOwn(await readJson(path, undefined), "body"), false);
  });
});

test("fails old multipart pending records closed after the composer protocol change", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    const body = "Version two compatibility body. ".repeat(30);
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body,
      correlationId: "version-two-resume",
    }, { directory, config: { maxMessageUnits: 300, recipientConcurrency: 4 } });

    const path = transactionPath(directory, "version-two-resume");
    const stored = await readJson(path, undefined);
    stored.version = 2;
    delete stored.envelopeLimit;
    await writeJson(path, stored);

    const failed = await drainUntilTerminal(runner, directory, "version-two-resume");
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.code, "LEGACY_PENDING_UNRESUMABLE");
    assert.equal(runner.submittedPayloads.length, 0);
  });
});

test("resumes and idempotently replays an admitted version-four envelope", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    const body = "Queued before the compact-envelope upgrade.";
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body,
      correlationId: "version-four-resume",
    }, { directory });

    const path = transactionPath(directory, "version-four-resume");
    const stored = await readJson(path, undefined);
    const legacyPayload = `${SENDER_TITLE} | ${RECIPIENT_TITLE} : ${body}`;
    stored.version = 4;
    stored.payloadHash = fingerprint(legacyPayload);
    stored.payloadLength = legacyPayload.length;
    stored.chunkHashes = [fingerprint(legacyPayload)];
    stored.chunkLengths = [legacyPayload.length];
    await writeJson(path, stored);

    const replay = await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body,
      correlationId: "version-four-resume",
    }, { directory });
    assert.equal(replay.code, "ALREADY_ACCEPTED");

    const delivered = await drainUntilTerminal(runner, directory, "version-four-resume");
    assert.equal(delivered.status, "DELIVERED");
    assert.equal(runner.submittedPayloads[0], legacyPayload);
  });
});

test("rejects reuse of one correlation for different exact content", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "First content",
      correlationId: "same-correlation",
    }, { directory });
    await assert.rejects(
      enqueueReliableMessage(runner, {
        senderPaneId: "sender-pane",
        recipientTitle: RECIPIENT_TITLE,
        body: "Different content",
        correlationId: "same-correlation",
      }, { directory }),
      (error) => error.code === "CORRELATION_CONFLICT",
    );
  });
});

test("treats the persisted envelope limit as part of correlation idempotency", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    const input = {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "Same exact short content",
      correlationId: "same-content-different-limit",
    };
    await enqueueReliableMessage(runner, input, {
      directory,
      config: { maxMessageUnits: 300, recipientConcurrency: 4 },
    });
    await assert.rejects(
      enqueueReliableMessage(runner, input, {
        directory,
        config: { maxMessageUnits: 500, recipientConcurrency: 4 },
      }),
      (error) => error.code === "CORRELATION_CONFLICT",
    );
  });
});

test("durably retains every simultaneous arrival with one unique FIFO sequence", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    const accepted = await Promise.all(["A", "B", "C", "D"].map((letter) => enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: `TARGET ${letter}`,
      body: `Simultaneous durable message ${letter}`,
      correlationId: `simultaneous-${letter.toLowerCase()}`,
    }, { directory })));

    assert.equal(accepted.length, 4);
    assert.deepEqual(accepted.map((entry) => entry.queueSequence).sort((left, right) => left - right), [1, 2, 3, 4]);
    const queued = await listQueueEntries(runner, "sender-pane", { directory });
    assert.equal(queued.length, 4);
    assert.deepEqual(queued.map((entry) => entry.queueSequence), [1, 2, 3, 4]);
  });
});

test("advances four destination heads concurrently without changing FIFO admission", async () => {
  await withDirectory(async (directory) => {
    const runner = new ParallelLaneRunner();
    for (const letter of ["A", "B", "C", "D"]) {
      await enqueueReliableMessage(runner, {
        senderPaneId: "sender-pane",
        recipientTitle: `TARGET ${letter}`,
        body: `Concurrent message ${letter}`,
        correlationId: `parallel-${letter.toLowerCase()}`,
      }, { directory });
    }

    const results = await drainPendingTransactions(runner, {
      directory,
      now: Date.now() + 60_000,
      recipientConcurrency: 4,
    });
    assert.equal(results.length, 4);
    assert.equal(runner.appendedChunks.length, 4);
    assert.equal(runner.maximumParallelRecipientReads, 4);
  });
});

test("preserves strict FIFO within one recipient lane", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "First lane message",
      correlationId: "lane-first",
    }, { directory });
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "Second lane message",
      correlationId: "lane-second",
    }, { directory });

    await drainPendingTransactions(runner, { directory, now: Date.now() + 60_000 });
    assert.equal(runner.appendedChunks.length, 1);
    const secondBefore = await readJson(transactionPath(directory, "lane-second"), undefined);
    assert.equal(secondBefore.checkpoint.loadedUnits, 0);

    await drainUntilTerminal(runner, directory, "lane-first");
    await drainUntilTerminal(runner, directory, "lane-second");
    assert.deepEqual(runner.submittedPayloads, [
      `[${SENDER_TITLE}:${RECIPIENT_TITLE}] First lane message`,
      `[${SENDER_TITLE}:${RECIPIENT_TITLE}] Second lane message`,
    ]);
  });
});

// Scheduler progress is safe only after the ambiguous head becomes terminal and loses its private body.
test("terminalizes a lost composer head body-free before advancing its FIFO follower", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "Ambiguous disappeared head",
      correlationId: "lost-head",
    }, { directory });
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "Follower remains ordered",
      correlationId: "lost-follower",
    }, { directory });
    const headPath = transactionPath(directory, "lost-head");
    const head = await readJson(headPath, undefined);
    head.checkpoint.loadedUnits = 1;
    head.checkpoint.loadedChunks = 1;
    await writeJson(headPath, head);

    await drainPendingTransactions(runner, { directory, now: Date.now() + 60_000 });
    await drainPendingTransactions(runner, { directory, now: Date.now() + 61_000 });
    const failed = await readJson(headPath, undefined);
    const followerBefore = await readJson(transactionPath(directory, "lost-follower"), undefined);

    assert.equal(failed.status, "FAILED");
    assert.equal(failed.code, "FAILED_AMBIGUOUS_COMPOSER_LOST");
    assert.equal(Object.hasOwn(failed, "body"), false);
    assert.equal(followerBefore.checkpoint.loadedUnits, 0);
    assert.equal(runner.appendedChunks.length, 0);

    await drainPendingTransactions(runner, { directory, now: Date.now() + 62_000 });
    assert.equal(runner.appendedChunks.length, 1);
  });
});

// A vanished pending append must become body-free and release the same destination lane.
test("terminalizes an unobserved append head before advancing its FIFO follower", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner();
    const headBody = "Ambiguous missing append head";
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: headBody,
      correlationId: "append-lost-head",
    }, { directory });
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "Follower after missing append",
      correlationId: "append-lost-follower",
    }, { directory });
    const headPath = transactionPath(directory, "append-lost-head");
    const head = await readJson(headPath, undefined);
    head.checkpoint.pendingAppendEnd = `[${SENDER_TITLE}:${RECIPIENT_TITLE}] ${headBody}`.length;
    head.checkpoint.pendingAppendAccepted = true;
    head.checkpoint.appendAttempts = 1;
    await writeJson(headPath, head);

    await drainPendingTransactions(runner, { directory, now: Date.now() + 60_000 });
    await drainPendingTransactions(runner, { directory, now: Date.now() + 61_000 });
    const early = await readJson(headPath, undefined);
    assert.equal(early.status, "PENDING");
    assert.equal(early.checkpoint.missingAppendObservations, 1);
    await drainPendingTransactions(runner, { directory, now: Date.now() + 65_000 });
    const failed = await readJson(headPath, undefined);
    const followerBefore = await readJson(transactionPath(directory, "append-lost-follower"), undefined);

    assert.equal(failed.status, "FAILED");
    assert.equal(failed.code, "FAILED_AMBIGUOUS_APPEND_LOST");
    assert.equal(Object.hasOwn(failed, "body"), false);
    assert.equal(followerBefore.checkpoint.loadedUnits, 0);
    assert.equal(runner.appendedChunks.length, 0);

    await drainPendingTransactions(runner, { directory, now: Date.now() + 66_000 });
    assert.equal(runner.appendedChunks.length, 1);
  });
});

test("retains arrivals received while another message is actively loading", async () => {
  await withDirectory(async (directory) => {
    const runner = new ParallelLaneRunner();
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: "TARGET A",
      body: "Active FIFO body ".repeat(80),
      correlationId: "active-head",
    }, { directory });
    await drainPendingTransactions(runner, { directory, now: Date.now() + 60_000 });

    await Promise.all([
      enqueueReliableMessage(runner, {
        senderPaneId: "sender-pane",
        recipientTitle: "TARGET A",
        body: "Queued behind the active destination head",
        correlationId: "active-follower",
      }, { directory }),
      enqueueReliableMessage(runner, {
        senderPaneId: "sender-pane",
        recipientTitle: "TARGET B",
        body: "Independent destination arrival",
        correlationId: "active-independent",
      }, { directory }),
    ]);

    await drainPendingTransactions(runner, { directory, now: Date.now() + 120_000, recipientConcurrency: 4 });
    const follower = await readJson(transactionPath(directory, "active-follower"), undefined);
    const independent = await readJson(transactionPath(directory, "active-independent"), undefined);
    assert.equal(follower.checkpoint.loadedUnits, 0);
    assert.ok(independent.checkpoint.pendingAppendEnd > 0 || independent.checkpoint.loadedUnits > 0);
    assert.equal((await listQueueEntries(runner, "sender-pane", { directory })).length, 3);
  });
});

// Status health must expose exact operational metadata without crossing the retained-body boundary.
test("reports deterministic body-free pending health for age and volume thresholds", async () => {
  await withDirectory(async (directory) => {
    const runner = new ServiceRunner({ recipientAvailable: false });
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "SENSITIVE BODY MUST NOT ENTER HEALTH OUTPUT",
      correlationId: "health-head",
    }, { directory });
    await enqueueReliableMessage(runner, {
      senderPaneId: "sender-pane",
      recipientTitle: RECIPIENT_TITLE,
      body: "Second pending body",
      correlationId: "health-follower",
    }, { directory });
    const head = await readJson(transactionPath(directory, "health-head"), undefined);
    const status = await getServiceStatus(directory, {
      now: Date.parse(head.createdAt) + 120_000,
      config: { pendingAlertAgeMs: 60_000, pendingAlertCount: 2 },
    });

    assert.equal(status.pendingHealth.level, "ALERT");
    assert.deepEqual(status.pendingHealth.reasons, [
      "PENDING_AGE_THRESHOLD_EXCEEDED",
      "PENDING_COUNT_THRESHOLD_EXCEEDED",
    ]);
    assert.equal(status.pendingHealth.pendingCount, 2);
    assert.equal(status.pendingHealth.oldestPendingAgeMs, 120_000);
    assert.equal(status.pendingHealth.head.correlationId, "health-head");
    assert.equal(status.pendingHealth.head.recipientTitle, RECIPIENT_TITLE);
    assert.equal(JSON.stringify(status).includes("SENSITIVE BODY"), false);
  });
});

/** Simulates Herdr lifecycle transitions while preserving every prompted payload for duplicate checks. */
class ServiceRunner {
  /** Creates an idle sender/recipient fixture; callers may keep the recipient absent until a later scan. */
  constructor(options = {}) {
    this.senderTitle = SENDER_TITLE;
    this.otherSenderTitle = "OTHER EXACT SENDER";
    this.recipientAvailable = options.recipientAvailable !== false;
    this.stateChangeSeq = 1;
    this.revision = 1;
    this.snapshot = "› Ask Codex";
    this.composer = "";
    this.appendedChunks = [];
    this.submittedPayloads = [];
    this.submitCalls = 0;
    this.agentStatus = "idle";
    this.postSubmitReads = 0;
  }

  /** Returns the exact current pane inventory used by identity resolution without normalizing labels. */
  panes() {
    return [
      pane("sender-pane", this.senderTitle, "sender-terminal"),
      pane("other-pane", this.otherSenderTitle, "other-terminal"),
      ...(this.recipientAvailable ? [pane("recipient-pane", RECIPIENT_TITLE, "recipient-terminal")] : []),
    ];
  }

  /** Emulates only the Herdr commands used by the service and fails on any unexpected command surface. */
  async run(args) {
    if (args[0] === "pane" && args[1] === "list") return { panes: this.panes() };
    if (args[0] === "agent" && args[1] === "get") {
      if (this.postSubmitReads > 0) {
        this.postSubmitReads += 1;
        if (this.postSubmitReads >= 3) this.agentStatus = "idle";
      }
      return { agent: { agent: "codex", pane_id: args[2], agent_status: this.agentStatus, state_change_seq: this.stateChangeSeq, revision: this.revision } };
    }
    if (args[0] === "pane" && args[1] === "send-text") {
      this.composer += args[3];
      this.appendedChunks.push(args[3]);
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
      this.snapshot = `› ${submitted}\n\n• Message received\n\n› Ask Codex`;
      return { agent: {} };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }

  /** Returns the current exact detection snapshot without performing a lifecycle transition. */
  async runText() {
    return this.snapshot;
  }
}

/** Emulates four independent panes and records true overlap between recipient reads. */
class ParallelLaneRunner {
  /** Creates four independent composers and concurrency counters for one dispatcher tick. */
  constructor() {
    this.appendedChunks = [];
    this.composers = new Map(["A", "B", "C", "D"].map((letter) => [`recipient-${letter}`, ""]));
    this.activeRecipientReads = new Set();
    this.maximumParallelRecipientReads = 0;
    this.recipientReadGate = new Promise((resolve) => { this.releaseRecipientReads = resolve; });
    this.snapshots = new Map(["A", "B", "C", "D"].map((letter) => [`recipient-${letter}`, "› Ask Codex"]));
  }

  panes() {
    return [
      pane("sender-pane", SENDER_TITLE, "sender-terminal"),
      ...["A", "B", "C", "D"].map((letter) => pane(`recipient-${letter}`, `TARGET ${letter}`, `terminal-${letter}`)),
    ];
  }

  async run(args) {
    if (args[0] === "pane" && args[1] === "list") return { panes: this.panes() };
    if (args[0] === "agent" && args[1] === "get") {
      const paneId = args[2];
      this.activeRecipientReads.add(paneId);
      this.maximumParallelRecipientReads = Math.max(this.maximumParallelRecipientReads, this.activeRecipientReads.size);
      if (this.activeRecipientReads.size === 4) this.releaseRecipientReads();
      await Promise.race([
        this.recipientReadGate,
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
      this.activeRecipientReads.delete(paneId);
      return { agent: { agent: "codex", pane_id: paneId, agent_status: "idle", state_change_seq: 1, revision: 1 } };
    }
    if (args[0] === "pane" && args[1] === "send-text") {
      const composer = `${this.composers.get(args[2]) || ""}${args[3]}`;
      this.composers.set(args[2], composer);
      this.appendedChunks.push({ paneId: args[2], chunk: args[3] });
      this.snapshots.set(args[2], `› ${composer}`);
      return { agent: {} };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }

  async runText(args) {
    return this.snapshots.get(args[2]) || "› Ask Codex";
  }
}

/**
 * Emulates three independent Herdr recipients with optional ambiguity and blocking.
 * Composer, transcript, lifecycle, and submission state remain isolated per exact pane so tests
 * can detect cross-destination stalls or duplicate submission without external processes.
 */
class MultiTargetRunner {
  /**
   * Initializes three empty composer lanes and their causal receipt counters.
   * `duplicateTitle` adds an ambiguous inventory entry; `blockedTitle` prevents only that exact
   * recipient from accepting composer work until the test clears it.
   */
  constructor(options = {}) {
    this.duplicateTitle = options.duplicateTitle;
    this.blockedTitle = options.blockedTitle;
    this.composers = new Map(["A", "B", "C"].map((letter) => [`recipient-${letter}`, ""]));
    this.snapshots = new Map(["A", "B", "C"].map((letter) => [`recipient-${letter}`, "› Ask Codex"]));
    this.stateChanges = new Map(["A", "B", "C"].map((letter) => [`recipient-${letter}`, 1]));
    this.submittedPayloads = new Map(["A", "B", "C"].map((letter) => [`recipient-${letter}`, []]));
  }

  /**
   * Emulates structured pane inventory, lifecycle, append, and submit commands.
   * Appends preserve exact fragments; submit clears only the addressed composer, increments its
   * causal counters, and records the payload. Any unsupported command fails the test immediately.
   */
  async run(args) {
    if (args[0] === "pane" && args[1] === "list") {
      const recipients = ["A", "B", "C"].map((letter) => ({
        ...pane(`recipient-${letter}`, `TARGET ${letter}`, `terminal-${letter}`),
        agent_status: this.blockedTitle === `TARGET ${letter}` ? "blocked" : "idle",
      }));
      if (this.duplicateTitle) recipients.push(pane("recipient-duplicate", this.duplicateTitle, "terminal-duplicate"));
      return { panes: [pane("sender-pane", SENDER_TITLE, "sender-terminal"), ...recipients] };
    }
    if (args[0] === "agent" && args[1] === "get") {
      const letter = args[2].at(-1);
      const title = `TARGET ${letter}`;
      return { agent: { agent: "codex", pane_id: args[2], agent_status: this.blockedTitle === title ? "blocked" : "idle", state_change_seq: this.stateChanges.get(args[2]), revision: this.stateChanges.get(args[2]) } };
    }
    if (args[0] === "pane" && args[1] === "send-text") {
      const composer = `${this.composers.get(args[2])}${args[3]}`;
      this.composers.set(args[2], composer);
      this.snapshots.set(args[2], `› ${composer}`);
      return { agent: {} };
    }
    if (args[0] === "agent" && args[1] === "send-keys") {
      const payload = this.composers.get(args[2]);
      this.submittedPayloads.get(args[2]).push(payload);
      this.composers.set(args[2], "");
      this.stateChanges.set(args[2], this.stateChanges.get(args[2]) + 1);
      this.snapshots.set(args[2], `› ${payload}\n\n• Received\n\n› Ask Codex`);
      return { agent: {} };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }

  /**
   * Returns the latest bounded detection snapshot for the requested pane.
   * Unknown panes receive an empty-composer placeholder; no fake state is mutated.
   */
  async runText(args) {
    return this.snapshots.get(args[2]) || "› Ask Codex";
  }
}

/** Builds one stable fake pane identity for pinning and replacement checks. */
function pane(paneId, label, terminalId) {
  return { pane_id: paneId, label, terminal_id: terminalId, workspace_id: "workspace", tab_id: "tab", agent_status: "working" };
}

/** Advances deterministic scheduler ticks until one exact transaction becomes terminal. */
async function drainUntilTerminal(runner, directory, correlationId, maximumTicks = 200) {
  const path = transactionPath(directory, correlationId);
  const base = Date.now() + 60_000;
  for (let tick = 0; tick < maximumTicks; tick += 1) {
    await drainPendingTransactions(runner, { directory, now: base + tick * 1_000 });
    const transaction = await readJson(path, undefined);
    if (transaction?.status !== "PENDING") return transaction;
  }
  assert.fail(`Transaction ${correlationId} did not become terminal within ${maximumTicks} ticks.`);
}

/** Runs one storage scenario in an isolated directory and removes it even when an assertion fails. */
async function withDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-service-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
