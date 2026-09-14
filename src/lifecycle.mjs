import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DAEMON_HEARTBEAT_INTERVAL_MS, DAEMON_HEARTBEAT_STALE_MS } from "./constants.mjs";
import { readJson, writeJson } from "./storage.mjs";

/** Returns the plugin-private directory holding daemon ownership metadata. */
export function runtimeDirectory(directory) {
  return join(directory, "runtime");
}

/** Checks a numeric PID without trusting a persisted heartbeat alone. */
export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reports daemon health from both live-process and fresh-heartbeat evidence. */
export async function getDaemonStatus(directory, now = Date.now()) {
  const runtime = await readJson(join(runtimeDirectory(directory), "daemon.json"), undefined);
  if (!isValidRuntime(runtime)) return { running: false, processAlive: false, heartbeatFresh: false };
  const processAlive = isProcessAlive(runtime.pid);
  const heartbeatTime = Date.parse(runtime.heartbeatAt);
  const heartbeatFresh = Number.isFinite(heartbeatTime) && now - heartbeatTime <= DAEMON_HEARTBEAT_STALE_MS;
  return { running: processAlive && heartbeatFresh, processAlive, heartbeatFresh, runtime };
}

/** Starts one detached daemon and waits for its first healthy heartbeat. */
export async function ensureDaemon(directory, entrypoint) {
  const current = await getDaemonStatus(directory);
  if (current.running || current.processAlive) return current;
  await mkdir(runtimeDirectory(directory), { recursive: true });
  await removeIfPresent(join(runtimeDirectory(directory), "stop-request.json"));
  const childEnvironment = { ...process.env, HERDR_RELIABLE_MESSAGING_DATA_DIR: directory };
  delete childEnvironment.HERDR_ENV;
  delete childEnvironment.HERDR_PANE_ID;
  delete childEnvironment.HERDR_TAB_ID;
  delete childEnvironment.HERDR_WORKSPACE_ID;
  const child = spawn(process.execPath, [entrypoint, "daemon"], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: childEnvironment,
  });
  child.unref();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(200);
    const observed = await getDaemonStatus(directory);
    if (observed.running) return observed;
  }
  return getDaemonStatus(directory);
}

/** Acquires exclusive daemon ownership and refreshes its heartbeat until release. */
export async function acquireDaemonLease(directory) {
  const runtimeDir = runtimeDirectory(directory);
  const lockPath = join(runtimeDir, "daemon.lock");
  await mkdir(runtimeDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const now = new Date().toISOString();
      const runtime = { pid: process.pid, instanceId: randomUUID(), startedAt: now, heartbeatAt: now };
      await handle.writeFile(`${JSON.stringify(runtime)}\n`, "utf8");
      await handle.close();
      await writeJson(join(runtimeDir, "daemon.json"), runtime);
      let heartbeatWrite = Promise.resolve();
      const timer = setInterval(() => {
        runtime.heartbeatAt = new Date().toISOString();
        heartbeatWrite = heartbeatWrite.then(() => writeJson(join(runtimeDir, "daemon.json"), runtime));
      }, DAEMON_HEARTBEAT_INTERVAL_MS);
      timer.unref();
      return {
        runtime,
        release: async () => {
          clearInterval(timer);
          await heartbeatWrite;
          const owner = await readJson(join(runtimeDir, "daemon.json"), undefined);
          if (owner?.instanceId !== runtime.instanceId) return;
          await removeIfPresent(join(runtimeDir, "daemon.json"));
          await removeIfPresent(lockPath);
          await removeIfPresent(join(runtimeDir, "stop-request.json"));
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await lockBelongsToLiveProcess(lockPath)) return undefined;
      await removeIfPresent(lockPath);
      await removeIfPresent(join(runtimeDir, "daemon.json"));
    }
  }
  return undefined;
}

/** Requests graceful daemon shutdown without killing an unrelated process. */
export async function requestDaemonStop(directory) {
  const status = await getDaemonStatus(directory);
  if (!status.processAlive || !status.runtime) return { requested: false, stopped: true };
  await writeJson(join(runtimeDirectory(directory), "stop-request.json"), {
    instanceId: status.runtime.instanceId,
    requestedAt: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(200);
    const observed = await getDaemonStatus(directory);
    if (!observed.processAlive) return { requested: true, stopped: true };
  }
  return { requested: true, stopped: false };
}

/** Checks whether the current daemon instance owns an exact graceful stop request. */
export async function hasDaemonStopRequest(directory, instanceId) {
  const request = await readJson(join(runtimeDirectory(directory), "stop-request.json"), undefined);
  return request?.instanceId === instanceId;
}

function isValidRuntime(value) {
  return value !== null && typeof value === "object" && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.instanceId === "string" && value.instanceId.length > 0 &&
    typeof value.startedAt === "string" && typeof value.heartbeatAt === "string";
}

async function lockBelongsToLiveProcess(path) {
  try {
    const owner = JSON.parse(await readFile(path, "utf8"));
    return isValidRuntime(owner) && isProcessAlive(owner.pid);
  } catch {
    try {
      return Date.now() - (await stat(path)).mtimeMs < 2_000;
    } catch {
      return false;
    }
  }
}

async function removeIfPresent(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
