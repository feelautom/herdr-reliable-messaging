import test from "node:test";
import assert from "node:assert/strict";
import { advanceComposerMessage, composerContentIsDimOnly, initialComposerCheckpoint, inspectEvidence } from "../src/delivery.mjs";
import { CLAUDE_PROFILE, CODEX_PROFILE, resolveAgentProfile } from "../src/agent-profiles.mjs";

const PAYLOAD = `[SOURCE PANE:TARGET PANE] ${"exact payload block ".repeat(70)}`;

/** Exact Claude Code chrome observed on a real pane, reused by every fixture below. */
const MARKER = "❯";
const NBSP = " ";
const BORDER = "─".repeat(90);
const FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
const SHELL_FOOTER = "  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage";

/** Exact styled composer lines captured from a real Claude pane. */
const ESC = "\u001B";
const DIM_SUGGESTION_LINE = `${MARKER}${NBSP} ${ESC}[0m${ESC}[2mGo ahead, start the release${ESC}[0m\r`;
const TYPED_TEXT_LINE = `${MARKER}${NBSP}this is text I typed myself\r`;

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

test("recognizes an entirely dimmed composer suggestion as agent-owned content", () => {
  const snapshot = [BORDER, DIM_SUGGESTION_LINE, BORDER, FOOTER].join("\n");
  assert.equal(composerContentIsDimOnly(snapshot, CLAUDE_PROFILE), true);
});

test("never treats unstyled user text as a suggestion", () => {
  const snapshot = [BORDER, TYPED_TEXT_LINE, BORDER, FOOTER].join("\n");
  assert.equal(composerContentIsDimOnly(snapshot, CLAUDE_PROFILE), false);
});

test("fails closed when the composer mixes dimmed and unstyled content", () => {
  const mixed = `${MARKER}${NBSP}${ESC}[2mdimmed start${ESC}[0m typed tail\r`;
  assert.equal(composerContentIsDimOnly([BORDER, mixed, BORDER].join("\n"), CLAUDE_PROFILE), false);
});

test("never applies the dim rule to a profile that does not declare it", () => {
  const snapshot = [BORDER, DIM_SUGGESTION_LINE, BORDER].join("\n");
  assert.equal(composerContentIsDimOnly(snapshot, CODEX_PROFILE), false);
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

test("delivers into a composer that only displays a dimmed Claude suggestion", async () => {
  const runner = new ClaudeComposerRunner({ suggestion: "Go ahead, start the release" });
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
  assert.equal(runner.submitCalls, 1);
  assert.ok(runner.styledReads > 0);
});

test("never writes over user text that the styled read shows as unstyled", async () => {
  const runner = new ClaudeComposerRunner({ typed: "this is text I typed myself" });

  const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, initialComposerCheckpoint(), async () => {});

  assert.equal(outcome.code, "TARGET_COMPOSER_OCCUPIED");
  assert.deepEqual(runner.appendedChunks, []);
  assert.equal(runner.submitCalls, 0);
  assert.ok(runner.styledReads > 0);
});

test("fails closed when the styled read is unavailable", async () => {
  const runner = new ClaudeComposerRunner({ suggestion: "Go ahead, start the release", styledReadFails: true });

  const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, initialComposerCheckpoint(), async () => {});

  assert.equal(outcome.code, "TARGET_COMPOSER_OCCUPIED");
  assert.deepEqual(runner.appendedChunks, []);
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
  /**
   * Creates an idle Claude target rendering the observed composer box and footer.
   *
   * `suggestion` displays agent-owned dimmed text, `typed` displays unstyled user text.
   * Both look identical in the detection snapshot and differ only in the styled read.
   */
  constructor(options = {}) {
    this.agent = Object.hasOwn(options, "agent") ? options.agent : "claude";
    this.footer = options.footer ?? FOOTER;
    this.suggestion = options.suggestion;
    this.typed = options.typed;
    this.styledReadFails = options.styledReadFails === true;
    this.styledReads = 0;
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
      this.suggestion = undefined;
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

  /** Returns the detection snapshot, or the styled one when the caller asks for ANSI. */
  async runText(args = []) {
    if (args.includes("--ansi")) {
      this.styledReads += 1;
      if (this.styledReadFails) throw new Error("styled read unavailable");
      return this.styledSnapshot();
    }
    return this.snapshot;
  }

  /** Renders the composer line with its exact styling for the ANSI read. */
  styledSnapshot() {
    let composerLine = MARKER;
    if (this.suggestion !== undefined) composerLine = `${MARKER}${NBSP} ${ESC}[0m${ESC}[2m${this.suggestion}${ESC}[0m\r`;
    else if (this.typed !== undefined) composerLine = `${MARKER}${NBSP}${this.typed}\r`;
    else if (this.composer.length > 0) composerLine = `${MARKER}${NBSP}${this.composer}\r`;
    return [BORDER, composerLine, BORDER, this.footer].join("\n");
  }

  /** Rebuilds the exact Claude rendering: transcript, boxed composer and mode footer. */
  refreshSnapshot() {
    const transcript = this.history.flatMap((payload) => [`${MARKER}${NBSP}${payload}`, "", "● Message received", ""]);
    let composerLine = MARKER;
    if (this.composer.length > 0) composerLine = `${MARKER}${NBSP}${this.composer}`;
    else if (this.suggestion !== undefined) composerLine = `${MARKER}${NBSP}${this.suggestion}`;
    else if (this.typed !== undefined) composerLine = `${MARKER}${NBSP}${this.typed}`;
    this.snapshot = claudeSnapshot(composerLine, { footer: this.footer, transcript });
  }
}
