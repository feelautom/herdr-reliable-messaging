import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemonLease, getDaemonStatus, hasDaemonStopRequest, runtimeDirectory } from "../src/lifecycle.mjs";
import { recordPendingHealthTransition } from "../src/daemon.mjs";
import { readJson, writeJson } from "../src/storage.mjs";

test("daemon lease is exclusive, heartbeated, and fully cleaned on release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-lifecycle-"));
  try {
    const lease = await acquireDaemonLease(directory);
    assert.ok(lease);
    const status = await getDaemonStatus(directory);
    assert.equal(status.running, true);
    assert.equal(status.runtime.instanceId, lease.runtime.instanceId);
    assert.equal(await acquireDaemonLease(directory), undefined);

    await writeJson(join(runtimeDirectory(directory), "stop-request.json"), {
      instanceId: lease.runtime.instanceId,
      requestedAt: new Date().toISOString(),
    });
    assert.equal(await hasDaemonStopRequest(directory, lease.runtime.instanceId), true);
    assert.equal(await hasDaemonStopRequest(directory, "other-instance"), false);

    await lease.release();
    assert.equal((await getDaemonStatus(directory)).running, false);
    assert.equal(await readJson(join(runtimeDirectory(directory), "daemon.json"), undefined), undefined);
    assert.equal(await readJson(join(runtimeDirectory(directory), "stop-request.json"), undefined), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// The daemon boundary must redact even a mistakenly supplied body and suppress identical alerts.
test("records one body-free daemon alert per pending-health transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "herdr-reliable-health-"));
  try {
    const state = {};
    const alert = {
      level: "ALERT",
      reasons: ["PENDING_COUNT_THRESHOLD_EXCEEDED"],
      pendingCount: 88,
      oldestPendingAgeMs: 60_000,
      head: {
        correlationId: "health-correlation",
        queueSequence: 325,
        recipientTitle: "EXACT TARGET",
        code: "TARGET_COMPOSER_OCCUPIED",
        body: "SENSITIVE BODY MUST NEVER REACH DIAGNOSTICS",
      },
    };

    assert.equal(await recordPendingHealthTransition(directory, alert, "STOPPED", state), true);
    assert.equal(await recordPendingHealthTransition(directory, alert, "STOPPED", state), false);
    assert.equal(await recordPendingHealthTransition(directory, { level: "HEALTHY", reasons: [], pendingCount: 0 }, "STOPPED", state), true);

    const lines = (await readFile(join(directory, "logs", "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].outcome, "alert");
    assert.equal(lines[1].outcome, "recovered");
    assert.equal(JSON.stringify(lines).includes("body"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
