import { setTimeout as delay } from "node:timers/promises";
import { DAEMON_POLL_INTERVAL_MS } from "./constants.mjs";
import { appendDiagnostic, cleanupTemporaryFiles, pruneTerminalTransactions } from "./storage.mjs";
import { drainPendingTransactions, getServiceStatus } from "./service.mjs";
import { hasDaemonStopRequest } from "./lifecycle.mjs";
import { drainPendingAlerts, ensureDeliveryAnomalies, pruneTerminalAlerts } from "./alerts.mjs";

/**
 * Runs the durable data and anomaly-control dispatchers until an exact stop condition.
 *
 * Data destinations advance every poll. Body-free anomaly discovery is rate-limited because
 * it scans durable transaction records, while already-created control alerts may advance on
 * every poll. Periodic cleanup and health diagnostics remain independent of both dispatchers.
 * Herdr, persistence, and diagnostic failures are contained to the current poll and recorded.
 * Control delivery has a shared native-call budget so a stuck alert cannot retain future
 * data-expiration scans. `clock` is a data-only deterministic test seam, not a runtime setting.
 */
export async function runDeliveryDaemon(runner, directory, lease, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DAEMON_POLL_INTERVAL_MS;
  const maintenanceIntervalCycles = options.maintenanceIntervalCycles ?? 120;
  const alertScanIntervalCycles = options.alertScanIntervalCycles ?? 10;
  const signal = options.signal;
  const pendingHealthState = {};
  let maintenanceCycle = 0;
  while (!signal?.aborted && !await hasDaemonStopRequest(directory, lease.runtime.instanceId)) {
    try {
      await drainPendingTransactions(runner, {
        directory,
        recipientConcurrency: options.recipientConcurrency,
        clock: options.clock,
      });
      if (maintenanceCycle % alertScanIntervalCycles === 0) {
        await ensureDeliveryAnomalies({
          directory,
          pendingAgeMs: options.config?.pendingAlertAgeMs,
        });
      }
      await drainPendingAlerts(runner, { directory, drainBudgetMs: options.alertDrainBudgetMs });
      if (maintenanceCycle % maintenanceIntervalCycles === 0) {
        const [, , , service] = await Promise.all([
          pruneTerminalTransactions(directory),
          pruneTerminalAlerts(directory),
          cleanupTemporaryFiles(directory),
          getServiceStatus(directory, { config: options.config }),
        ]);
        await recordPendingHealthTransition(directory, service.pendingHealth, "RUNNING", pendingHealthState);
      }
      maintenanceCycle += 1;
    } catch (error) {
      await appendDiagnostic(directory, {
        component: "daemon",
        stage: "poll",
        outcome: "failed",
        errorCode: typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR",
      });
    }
    await delay(pollIntervalMs, undefined, signal ? { signal } : undefined).catch((error) => {
      if (error?.name !== "AbortError") throw error;
    });
  }
}

/**
 * Persists only meaningful pending-health transitions while suppressing identical poll noise.
 *
 * The caller owns the in-memory state for one daemon lifetime. A restart may emit one fresh
 * alert, which is intentional operational evidence, while no message body enters diagnostics.
 */
export async function recordPendingHealthTransition(directory, health, daemonState, state) {
  if (health.level === "ALERT") {
    const key = pendingHealthKey(health);
    if (state.lastPendingHealthKey === key) return false;
    await appendDiagnostic(directory, {
      component: "daemon",
      stage: "pending_health",
      outcome: "alert",
      daemon: daemonState,
      reasons: health.reasons,
      pendingCount: health.pendingCount,
      oldestPendingAgeMs: health.oldestPendingAgeMs,
      head: pendingHealthDiagnosticHead(health.head),
    });
    state.lastPendingHealthKey = key;
    return true;
  }
  if (state.lastPendingHealthKey === undefined) return false;
  await appendDiagnostic(directory, {
    component: "daemon",
    stage: "pending_health",
    outcome: "recovered",
    daemon: daemonState,
    reasons: [],
    pendingCount: health.pendingCount,
  });
  delete state.lastPendingHealthKey;
  return true;
}

/** Projects only the approved body-free head fields across the diagnostic boundary. */
function pendingHealthDiagnosticHead(head) {
  if (!head) return undefined;
  return {
    correlationId: head.correlationId,
    queueSequence: head.queueSequence,
    recipientTitle: head.recipientTitle,
    code: head.code,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
  };
}

/** Builds one exact body-free deduplication key from material pending-health fields. */
function pendingHealthKey(health) {
  return JSON.stringify([
    health.reasons,
    health.pendingCount,
    health.head?.correlationId,
    health.head?.queueSequence,
    health.head?.recipientTitle,
    health.head?.code,
  ]);
}
