import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStateLock, appendDiagnostic, batchManifestPath, cleanupTemporaryFiles, findTransactionPath, listTransactionPaths, pruneTerminalTransactions, readJson, transactionPath, writeBatchAtomically, writeJson } from "../src/storage.mjs";

test("writes JSON atomically and maps hostile correlations to safe file names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-storage-"));
  try {
    const path = transactionPath(directory, "../../hostile-but-opaque");
    assert.equal(path.startsWith(join(directory, "transactions")), true);
    assert.equal(path.includes(".."), false);
    await writeJson(path, { status: "PENDING" });
    assert.deepEqual(await readJson(path, undefined), { status: "PENDING" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes one internal state critical section", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-lock-"));
  try {
    const release = await acquireStateLock(directory, "queue-admission");
    await assert.rejects(
      acquireStateLock(directory, "queue-admission", { timeoutMs: 30, staleMs: 60_000 }),
      (error) => error.code === "STATE_BUSY",
    );
    await release();
    const releaseAgain = await acquireStateLock(directory, "queue-admission", { timeoutMs: 30 });
    await releaseAgain();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostics contain supplied metadata without requiring a message body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-log-"));
  try {
    await appendDiagnostic(directory, { correlationId: "case-1", payloadLength: 42, payloadHash: "abc", stage: "prompt" });
    const raw = await readFile(join(directory, "logs", "events.jsonl"), "utf8");
    assert.match(raw, /"correlationId":"case-1"/u);
    assert.doesNotMatch(raw, /messageBody|payloadBody/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prunes only terminal transactions outside the configured retention bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-prune-"));
  try {
    const delivered = transactionPath(directory, "delivered");
    const canceled = transactionPath(directory, "canceled");
    const pending = transactionPath(directory, "pending");
    await writeJson(delivered, { status: "DELIVERED", updatedAt: new Date(0).toISOString() });
    await writeJson(canceled, { status: "CANCELED", updatedAt: new Date(0).toISOString() });
    await writeJson(pending, { status: "PENDING", updatedAt: new Date(0).toISOString() });
    assert.equal(await pruneTerminalTransactions(directory, { retentionMs: 1, maximumTerminal: 10 }), 2);
    assert.equal(await readJson(delivered, undefined), undefined);
    assert.equal(await readJson(canceled, undefined), undefined);
    assert.equal((await readJson(pending, undefined)).status, "PENDING");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Proves retention never splits the proof records of one atomically admitted batch. */
test("prunes a complete terminal batch as one retention group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-batch-prune-"));
  try {
    const old = new Date(0).toISOString();
    await writeBatchAtomically(directory, "batch-retention", {
      batchCorrelationId: "batch-retention",
      childCorrelationIds: ["child-a", "child-b"],
    }, [
      { correlationId: "child-a", status: "DELIVERED", updatedAt: old },
      { correlationId: "child-b", status: "PENDING", updatedAt: old },
    ]);
    assert.equal(await pruneTerminalTransactions(directory, { retentionMs: 1, maximumTerminal: 10 }), 0);
    assert.equal((await listTransactionPaths(directory)).length, 2);

    const childB = await findTransactionPath(directory, "child-b");
    await writeJson(childB, { correlationId: "child-b", status: "FAILED", updatedAt: old });
    assert.equal(await pruneTerminalTransactions(directory, { retentionMs: 1, maximumTerminal: 10 }), 2);
    assert.equal((await listTransactionPaths(directory)).length, 0);
    assert.equal(await readJson(batchManifestPath(directory, "batch-retention"), undefined), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Proves cleanup removes only expired root files and unpublished batch staging directories. */
test("removes only abandoned atomic-write temporary files after the grace period", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-temporary-"));
  try {
    const transactions = join(directory, "transactions");
    const stale = join(transactions, "stale.json.write.tmp");
    const recent = join(transactions, "recent.json.write.tmp");
    await writeJson(join(transactions, "keep.json"), { status: "PENDING" });
    await writeFile(stale, "stale", "utf8");
    await writeFile(recent, "recent", "utf8");
    const old = new Date(Date.now() - 120_000);
    await utimes(stale, old, old);
    const staleBatch = join(transactions, "batches", ".stale-batch.tmp");
    await mkdir(staleBatch, { recursive: true });
    await writeFile(join(staleBatch, "child.json"), "stale", "utf8");
    await utimes(staleBatch, old, old);

    assert.equal(await cleanupTemporaryFiles(directory, { minimumAgeMs: 60_000 }), 2);
    await assert.rejects(readFile(stale, "utf8"), (error) => error.code === "ENOENT");
    await assert.rejects(readFile(join(staleBatch, "child.json"), "utf8"), (error) => error.code === "ENOENT");
    assert.equal(await readFile(recent, "utf8"), "recent");
    assert.equal((await readJson(join(transactions, "keep.json"), undefined)).status, "PENDING");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
