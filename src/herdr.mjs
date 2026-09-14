import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Error preserving Herdr's stable machine-readable failure code. */
export class HerdrCommandError extends Error {
  constructor(message, code = "herdr_command_failed", stderr = "") {
    super(message);
    this.name = "HerdrCommandError";
    this.code = code;
    this.stderr = stderr;
  }
}

/** Production runner that invokes the installed Herdr executable without a shell. */
export class CliHerdrRunner {
  constructor(executable = process.env.HERDR_BIN_PATH || "herdr") {
    this.executable = executable;
  }

  /**
   * Runs one structured command without a shell. An optional caller deadline bounds
   * the child process; timeout is ambiguous for writes and never authorizes a replay.
   */
  async run(args, options = {}) {
    try {
      const { stdout } = await execFileAsync(this.executable, [...args], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: options.timeoutMs,
      });
      return decodeEnvelope(stdout);
    } catch (error) {
      const decoded = decodeError(error?.stdout);
      throw new HerdrCommandError(
        decoded.message || "Herdr command failed",
        decoded.code || "herdr_command_failed",
        typeof error?.stderr === "string" ? error.stderr : "",
      );
    }
  }

  /** Runs one text observation with the same optional deadline and ambiguous timeout semantics. */
  async runText(args, options = {}) {
    try {
      const { stdout } = await execFileAsync(this.executable, [...args], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: options.timeoutMs,
      });
      return stdout;
    } catch (error) {
      const decoded = decodeError(error?.stdout);
      throw new HerdrCommandError(
        decoded.message || "Herdr text command failed",
        decoded.code || "herdr_command_failed",
        typeof error?.stderr === "string" ? error.stderr : "",
      );
    }
  }
}

/** Lists all panes visible to the running Herdr server. */
export async function listPanes(runner) {
  const result = await runner.run(["pane", "list"]);
  return result.panes;
}

/** Reads current lifecycle counters for one exact pane identifier. */
export async function getAgent(runner, paneId) {
  const result = await runner.run(["agent", "get", paneId]);
  return result.agent;
}

/** Reads the bounded detection snapshot used as delivery evidence. */
export async function readDetection(runner, paneId) {
  return runner.runText(["agent", "read", paneId, "--source", "detection", "--lines", "160"]);
}

/** Reads a deeper recent transcript only when bounded detection lost a long receipt. */
export async function readRecentHistory(runner, paneId) {
  return runner.runText(["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", "4096"]);
}

/** Appends one exact fragment to a pane composer without submitting it. */
export async function appendComposerText(runner, paneId, fragment) {
  return runner.run(["pane", "send-text", paneId, fragment]);
}

/** Applies the only permitted raw gesture after exact composer inspection. */
export async function submitExactComposer(runner, paneId) {
  return runner.run(["agent", "send-keys", paneId, "enter", "enter"]);
}

function decodeEnvelope(raw) {
  const envelope = JSON.parse(raw);
  if (envelope.error) {
    throw new HerdrCommandError(
      envelope.error.message || "Herdr returned an error",
      envelope.error.code || "herdr_error",
    );
  }
  if (envelope.result === undefined) {
    throw new HerdrCommandError("Herdr response did not contain a result", "invalid_response");
  }
  return envelope.result;
}

function decodeError(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    return JSON.parse(raw).error || {};
  } catch {
    return {};
  }
}
