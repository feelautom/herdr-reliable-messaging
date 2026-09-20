import test from "node:test";
import assert from "node:assert/strict";
import { advanceComposerMessage, initialComposerCheckpoint, inspectEvidence } from "../src/delivery.mjs";
import { CLAUDE_PROFILE, CODEX_PROFILE, resolveAgentProfile } from "../src/agent-profiles.mjs";

const PAYLOAD = `[SOURCE PANE:TARGET PANE] ${"exact payload block ".repeat(70)}`;

/** Exact Claude Code chrome observed on a real pane, reused by every fixture below. */
const MARKER = "❯";
const NBSP = " ";
const BORDER = "─".repeat(90);
const FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
const SHELL_FOOTER = "  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage";

/** Builds one detection snapshot with the exact Claude composer box and mode chrome. */
function claudeSnapshot(composerLine, { footer = FOOTER, transcript = [] } = {}) {
  return [...transcript, BORDER, composerLine, BORDER, footer].join("\n");
}

test("recognizes a bare Claude marker as an exactly empty composer", () => {
  const snapshot = claudeSnapshot(MARKER);
  const evidence = inspectEvidence(snapshot, PAYLOAD, initialComposerCheckpoint(), CLAUDE_PROFILE);
  assert.equal(evidence.composerEmpty, true);
  assert.equal(evidence.composerOccupied, false);
});

test("recognizes the dimmed Claude suggestion as an empty composer", () => {
  const snapshot = claudeSnapshot(`${MARKER}${NBSP}Try "how do I log an error?"`);
  assert.equal(inspectEvidence(snapshot, PAYLOAD, initialComposerCheckpoint(), CLAUDE_PROFILE).composerEmpty, true);
});

test("accepts both the ASCII space and the non-breaking space after the Claude marker", () => {
  const nbsp = claudeSnapshot(`${MARKER}${NBSP}${PAYLOAD.slice(0, 40)}`);
  const ascii = claudeSnapshot(`${MARKER} ${PAYLOAD.slice(0, 40)}`);
  const checkpoint = { ...initialComposerCheckpoint(), loadedUnits: 40 };
  assert.equal(inspectEvidence(nbsp, PAYLOAD, checkpoint, CLAUDE_PROFILE).composerUnits, 40);
  assert.equal(inspectEvidence(ascii, PAYLOAD, checkpoint, CLAUDE_PROFILE).composerUnits, 40);
});

test("treats mode chrome below the composer border as chrome, not as activity", () => {
  const shell = claudeSnapshot(MARKER, { footer: SHELL_FOOTER });
  assert.equal(inspectEvidence(shell, PAYLOAD, initialComposerCheckpoint(), CLAUDE_PROFILE).composerEmpty, true);
});

test("keeps a Claude composer holding unrelated user text explicitly occupied", () => {
  const snapshot = claudeSnapshot(`${MARKER}${NBSP}unrelated user text`);
  const evidence = inspectEvidence(snapshot, PAYLOAD, initialComposerCheckpoint(), CLAUDE_PROFILE);
  assert.equal(evidence.composerEmpty, false);
  assert.equal(evidence.composerOccupied, true);
});

test("counts one exact Claude receipt without matching unrelated transcript entries", () => {
  const snapshot = claudeSnapshot(MARKER, {
    transcript: [`${MARKER}${NBSP}${PAYLOAD}`, "", "● Message received", "", `${MARKER}${NBSP}autre message`, ""],
  });
  const evidence = inspectEvidence(snapshot, PAYLOAD, initialComposerCheckpoint(), CLAUDE_PROFILE);
  assert.equal(evidence.submittedCount, 1);
  assert.equal(evidence.queuedCount, 0);
});

test("reports a Claude permission prompt as blocking user interface", () => {
  const snapshot = claudeSnapshot(MARKER, { transcript: ["Do you want to proceed?", "", "❯ 1. Yes", ""] });
  assert.equal(inspectEvidence(snapshot, PAYLOAD, initialComposerCheckpoint(), CLAUDE_PROFILE).blockingUi, true);
});

test("reproduces the original defect: Codex markers never see a free Claude composer", () => {
  const snapshot = claudeSnapshot(MARKER);
  const evidence = inspectEvidence(snapshot, PAYLOAD, initialComposerCheckpoint(), CODEX_PROFILE);
  assert.equal(evidence.composerEmpty, false);
});

test("delivers one long message to a Claude pane with exactly one submission", async () => {
  const runner = new ClaudeComposerRunner();
  let checkpoint = initialComposerCheckpoint();
  const persist = async (value) => { checkpoint = { ...value }; };
  let outcome;

  for (let tick = 0; tick < 30; tick += 1) {
    outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);
    checkpoint = outcome.checkpoint;
    if (outcome.status === "DELIVERED") break;
  }

  assert.equal(outcome.status, "DELIVERED");
  assert.equal(outcome.code, "DELIVERY_CONFIRMED");
  assert.equal(runner.appendedChunks.join(""), PAYLOAD);
  assert.ok(runner.appendedChunks.length > 1);
  assert.equal(runner.submitCalls, 1);
  assert.deepEqual(runner.submittedPayloads, [PAYLOAD]);
  assert.equal(runner.composer, "");
});

test("delivers to a Claude pane that keeps one shell running", async () => {
  const runner = new ClaudeComposerRunner({ footer: SHELL_FOOTER });
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

test("never writes into a Claude composer already holding user text", async () => {
  const runner = new ClaudeComposerRunner();
  runner.composer = "unrelated user draft";
  runner.refreshSnapshot();
  let checkpoint = initialComposerCheckpoint();
  const persist = async (value) => { checkpoint = { ...value }; };

  const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, persist);

  assert.equal(outcome.status, "PENDING");
  assert.equal(outcome.code, "TARGET_COMPOSER_OCCUPIED");
  assert.deepEqual(runner.appendedChunks, []);
  assert.equal(runner.submitCalls, 0);
  assert.equal(runner.composer, "unrelated user draft");
});

test("fails closed on an unsupported agent instead of writing with foreign markers", async () => {
  const runner = new ClaudeComposerRunner({ agent: "cline" });
  const checkpoint = initialComposerCheckpoint();

  const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, checkpoint, async () => {});

  assert.equal(outcome.status, "PENDING");
  assert.equal(outcome.code, "TARGET_AGENT_UNSUPPORTED");
  assert.deepEqual(runner.appendedChunks, []);
  assert.equal(runner.submitCalls, 0);
});

test("fails closed when Herdr reports no agent at all for the target pane", async () => {
  const runner = new ClaudeComposerRunner({ agent: undefined });

  const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, initialComposerCheckpoint(), async () => {});

  assert.equal(outcome.code, "TARGET_AGENT_UNSUPPORTED");
  assert.deepEqual(runner.appendedChunks, []);
});

test("resolves profiles on exact agent identifiers only", () => {
  assert.equal(resolveAgentProfile("claude"), CLAUDE_PROFILE);
  assert.equal(resolveAgentProfile("claude-code"), CLAUDE_PROFILE);
  assert.equal(resolveAgentProfile("codex"), CODEX_PROFILE);
  assert.equal(resolveAgentProfile("Claude"), undefined);
  assert.equal(resolveAgentProfile(" claude"), undefined);
  assert.equal(resolveAgentProfile(undefined), undefined);
});

/** Provides deterministic Claude Code composer behavior with its exact boxed chrome. */
class ClaudeComposerRunner {
  /** Creates an idle Claude target rendering the observed composer box and footer. */
  constructor(options = {}) {
    this.agent = Object.hasOwn(options, "agent") ? options.agent : "claude";
    this.footer = options.footer ?? FOOTER;
    this.status = "idle";
    this.stateChangeSeq = 1;
    this.revision = 1;
    this.composer = "";
    this.history = [];
    this.appendedChunks = [];
    this.submittedPayloads = [];
    this.submitCalls = 0;
    this.refreshSnapshot();
  }

  /** Emulates only the Herdr operations used by the composer state machine. */
  async run(args) {
    if (args[0] === "agent" && args[1] === "get") {
      const agent = { pane_id: args[2], agent_status: this.status, state_change_seq: this.stateChangeSeq, revision: this.revision };
      if (this.agent !== undefined) agent.agent = this.agent;
      return { agent };
    }
    if (args[0] === "pane" && args[1] === "send-text") {
      this.appendedChunks.push(args[3]);
      this.composer += args[3];
      this.refreshSnapshot();
      return {};
    }
    if (args[0] === "agent" && args[1] === "send-keys") {
      this.submitCalls += 1;
      this.submittedPayloads.push(this.composer);
      this.history.push(this.composer);
      this.composer = "";
      this.stateChangeSeq += 1;
      this.revision += 1;
      this.refreshSnapshot();
      return {};
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }

  /** Returns the current exact detection snapshot without changing lifecycle state. */
  async runText() {
    return this.snapshot;
  }

  /** Rebuilds the exact Claude rendering: transcript, boxed composer and mode footer. */
  refreshSnapshot() {
    const transcript = this.history.flatMap((payload) => [`${MARKER}${NBSP}${payload}`, "", "● Message received", ""]);
    const composerLine = this.composer.length > 0 ? `${MARKER}${NBSP}${this.composer}` : MARKER;
    this.snapshot = claudeSnapshot(composerLine, { footer: this.footer, transcript });
  }
}
