import test from "node:test";
import assert from "node:assert/strict";
import { advanceComposerMessage, initialComposerCheckpoint, inspectEvidence } from "../src/delivery.mjs";
import { CODEX_PROFILE, GEMINI_PROFILE, resolveAgentProfile } from "../src/agent-profiles.mjs";

const PAYLOAD = `[SOURCE PANE:TARGET PANE] ${"exact payload block ".repeat(70)}`;

/** Exact Gemini CLI chrome observed on a real pane, reused by every fixture below. */
const TOP = "▄".repeat(120);
const BOTTOM = "▀".repeat(120);
const PLACEHOLDER = " >   Type your message or @path/to/file";
const MODE_LINE = " auto-accept edits Shift+Tab to plan";
const SHORTCUTS = "                    ? for shortcuts";

/** Builds one detection snapshot with the exact Gemini composer box and mode chrome. */
function geminiSnapshot(composerLines, { transcript = [] } = {}) {
  return [...transcript, SHORTCUTS, MODE_LINE, TOP, ...composerLines, BOTTOM].join("\n");
}

/** Renders one exact Gemini entry, wrapping to the observed three-column indent. */
function geminiEntry(text, width = 160) {
  const lines = [];
  let rest = text;
  let first = true;
  while (rest.length > 0) {
    const limit = first ? width : width - 3;
    if (rest.length <= limit) { lines.push(first ? ` > ${rest}` : `   ${rest}`); break; }
    let cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    lines.push(first ? ` > ${rest.slice(0, cut)}` : `   ${rest.slice(0, cut)}`);
    rest = rest.slice(rest[cut] === " " ? cut + 1 : cut);
    first = false;
  }
  return lines;
}

test("recognizes the Gemini idle placeholder as an empty composer", () => {
  const evidence = inspectEvidence(geminiSnapshot([PLACEHOLDER]), PAYLOAD, initialComposerCheckpoint(), GEMINI_PROFILE);
  assert.equal(evidence.composerEmpty, true);
  assert.equal(evidence.composerOccupied, false);
});

test("reads an exact loaded prefix from the Gemini composer", () => {
  const prefix = PAYLOAD.slice(0, 40);
  const checkpoint = { ...initialComposerCheckpoint(), loadedUnits: 40 };
  const evidence = inspectEvidence(geminiSnapshot([` > ${prefix}`]), PAYLOAD, checkpoint, GEMINI_PROFILE);
  assert.equal(evidence.composerUnits, 40);
});

test("reconstructs a Gemini entry wrapped at the three-column continuation indent", () => {
  const snapshot = geminiSnapshot(geminiEntry(PAYLOAD));
  const evidence = inspectEvidence(snapshot, PAYLOAD, { ...initialComposerCheckpoint(), loadedUnits: PAYLOAD.length }, GEMINI_PROFILE);
  assert.equal(evidence.composerUnits, PAYLOAD.length);
  assert.equal(evidence.composerOccupied, false);
});

test("keeps a Gemini composer holding unrelated user text explicitly occupied", () => {
  const evidence = inspectEvidence(geminiSnapshot([" > unrelated user draft"]), PAYLOAD, initialComposerCheckpoint(), GEMINI_PROFILE);
  assert.equal(evidence.composerEmpty, false);
  assert.equal(evidence.composerOccupied, true);
});

test("counts one exact Gemini receipt from the submitted message box", () => {
  const snapshot = geminiSnapshot([PLACEHOLDER], {
    transcript: [TOP, ...geminiEntry(PAYLOAD), BOTTOM, "", "✕ [API Error: request failed]", ""],
  });
  const evidence = inspectEvidence(snapshot, PAYLOAD, initialComposerCheckpoint(), GEMINI_PROFILE);
  assert.equal(evidence.submittedCount, 1);
  assert.equal(evidence.composerEmpty, true);
});

test("reproduces the original defect: Codex markers never see a free Gemini composer", () => {
  const evidence = inspectEvidence(geminiSnapshot([PLACEHOLDER]), PAYLOAD, initialComposerCheckpoint(), CODEX_PROFILE);
  assert.equal(evidence.composerEmpty, false);
});

test("recognizes the YOLO-mode marker as the same Gemini composer", () => {
  const yolo = [SHORTCUTS, " YOLO Ctrl+Y", TOP, " *   Type your message or @path/to/file", BOTTOM].join("\n");
  const evidence = inspectEvidence(yolo, PAYLOAD, initialComposerCheckpoint(), GEMINI_PROFILE);
  assert.equal(evidence.composerEmpty, true);
  assert.equal(evidence.composerOccupied, false);
});

test("reads an exact loaded prefix from a YOLO-mode Gemini composer", () => {
  const prefix = PAYLOAD.slice(0, 40);
  const yolo = [SHORTCUTS, " YOLO Ctrl+Y", TOP, ` * ${prefix}`, BOTTOM].join("\n");
  const checkpoint = { ...initialComposerCheckpoint(), loadedUnits: 40 };
  assert.equal(inspectEvidence(yolo, PAYLOAD, checkpoint, GEMINI_PROFILE).composerUnits, 40);
});

test("resolves the Gemini profile on its exact agent identifier", () => {
  assert.equal(resolveAgentProfile("gemini"), GEMINI_PROFILE);
  assert.equal(resolveAgentProfile("Gemini"), undefined);
});

test("delivers one long message to a Gemini pane with exactly one submission", async () => {
  const runner = new GeminiComposerRunner();
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

test("never writes into a Gemini composer already holding user text", async () => {
  const runner = new GeminiComposerRunner();
  runner.composer = "unrelated user draft";
  runner.refreshSnapshot();

  const outcome = await advanceComposerMessage(runner, "target", PAYLOAD, 500, initialComposerCheckpoint(), async () => {});

  assert.equal(outcome.code, "TARGET_COMPOSER_OCCUPIED");
  assert.deepEqual(runner.appendedChunks, []);
  assert.equal(runner.composer, "unrelated user draft");
});

/** Provides deterministic Gemini CLI composer behavior with its exact boxed chrome. */
class GeminiComposerRunner {
  /** Creates an idle Gemini target rendering the observed composer box and mode line. */
  constructor() {
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
      return { agent: { agent: "gemini", pane_id: args[2], agent_status: this.status, state_change_seq: this.stateChangeSeq, revision: this.revision } };
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

  /** Rebuilds the exact Gemini rendering: submitted boxes, then the live composer box. */
  refreshSnapshot() {
    const transcript = this.history.flatMap((payload) => [TOP, ...geminiEntry(payload), BOTTOM, ""]);
    const composerLines = this.composer.length > 0 ? geminiEntry(this.composer) : [PLACEHOLDER];
    this.snapshot = geminiSnapshot(composerLines, { transcript });
  }
}
