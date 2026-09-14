import test from "node:test";
import assert from "node:assert/strict";
import { createExternalSender, listTargets, resolveEndpoints, resolveMessageSender, resolveRecipientsByTitles, verifyPinnedEndpoints } from "../src/identity.mjs";

const panes = [
  pane("source", "AUTHOR"),
  pane("target", "REVIEWER"),
  pane("worker", "RUNNER"),
];

/** Proves discovery and sender resolution retain every exact pane title regardless of role. */
test("accepts every live named pane without classifying its role", async () => {
  const targets = await listTargets(fakeRunner(panes));
  assert.deepEqual(targets.map(({ title }) => title).sort(), panes.map(({ label }) => label).sort());
  assert.equal((await resolveMessageSender(fakeRunner(panes), { paneId: "worker" })).title, "RUNNER");
});

/** Proves worker and orchestrator recipients share exact, case-sensitive routing semantics. */
test("resolves recipient titles with exact ordinal semantics", async () => {
  const runner = fakeRunner(panes);
  const resolved = await resolveEndpoints(runner, "source", "REVIEWER");
  assert.equal(resolved.recipient.pane_id, "target");
  const workerTarget = await resolveEndpoints(runner, "source", "RUNNER");
  assert.equal(workerTarget.recipient.pane_id, "worker");
  await assert.rejects(
    resolveEndpoints(runner, "source", "reviewer"),
    (error) => error.code === "TARGET_UNAVAILABLE",
  );
});

/** Proves worker senders are accepted while ambiguous exact destinations still fail closed. */
test("allows worker senders and rejects only duplicate target titles", async () => {
  const endpoints = await resolveEndpoints(fakeRunner(panes), "worker", "REVIEWER");
  assert.equal(endpoints.sender.label, "RUNNER");
  await assert.rejects(
    resolveEndpoints(fakeRunner([...panes, pane("target-2", "REVIEWER")]), "source", "REVIEWER"),
    (error) => error.code === "TARGET_AMBIGUOUS",
  );
});

/** Proves external labels are visible, exact, bounded, control-free, and never mixed with pane identity. */
test("creates explicit external identities without fabricating pane identifiers", async () => {
  assert.deepEqual(createExternalSender("LOCAL AUTOMATION"), {
    kind: "external",
    externalLabel: "LOCAL AUTOMATION",
    title: "EXTERNAL LOCAL AUTOMATION",
  });
  assert.deepEqual(await resolveMessageSender(fakeRunner(panes), { externalLabel: "SCRIPT LOCAL" }), {
    kind: "external",
    externalLabel: "SCRIPT LOCAL",
    title: "EXTERNAL SCRIPT LOCAL",
  });
  await assert.rejects(
    resolveMessageSender(fakeRunner(panes), { paneId: "worker", externalLabel: "AMBIGUOUS" }),
    (error) => error.code === "SOURCE_CONFLICT",
  );
  for (const invalidLabel of ["", " PADDED", "PADDED ", "TWO\nLINES", "TAB\tINSIDE", "ESC\u001b[31m", "LINE\u2028SEPARATOR", "x".repeat(121)]) {
    assert.throws(() => createExternalSender(invalidLabel), (error) => error.code === "EXTERNAL_SOURCE_INVALID");
  }
  assert.notEqual(createExternalSender("Å").title, createExternalSender("A\u030a").title);
});

test("pins pane, terminal, workspace, tab, and exact title identities", async () => {
  const pins = {
    sender: { paneId: "source", terminalId: "source-terminal", workspaceId: "workspace", tabId: "tab", title: panes[0].label },
    recipient: { paneId: "target", terminalId: "target-terminal", workspaceId: "workspace", tabId: "tab", title: panes[1].label },
  };
  assert.equal(await verifyPinnedEndpoints(fakeRunner(panes), pins), true);
  const replaced = panes.map((item) => item.pane_id === "target" ? { ...item, terminal_id: "replacement-terminal" } : item);
  assert.equal(await verifyPinnedEndpoints(fakeRunner(replaced), pins), false);
});

/** Proves batch routing uses one inventory and reports exact ambiguity candidates. */
test("resolves a batch atomically and exposes body-free exact ambiguity candidates", async () => {
  const duplicateTitle = "DUPLICATE";
  const inventory = [...panes, pane("duplicate-1", duplicateTitle), pane("duplicate-2", duplicateTitle)];
  const runner = fakeRunner(inventory);
  const resolved = await resolveRecipientsByTitles(runner, [panes[1].label, panes[2].label]);
  assert.deepEqual(resolved.map(({ pane_id }) => pane_id), ["target", "worker"]);
  assert.equal(runner.inventoryReads, 1);

  await assert.rejects(
    resolveRecipientsByTitles(fakeRunner(inventory), [duplicateTitle]),
    (error) => error.code === "TARGET_AMBIGUOUS" && error.details.candidates.length === 2 &&
      error.details.candidates.every((candidate) => !Object.hasOwn(candidate, "body")) &&
      error.details.suggestedRenames.every((suggestion) => suggestion.suggestedTitle.includes(suggestion.paneId)),
  );
});

/** Proves discovery filters exact fields without normalizing human-authored values. */
test("filters target discovery by exact title and status", async () => {
  const runner = fakeRunner(panes);
  assert.deepEqual((await listTargets(runner, { title: panes[1].label })).map(({ paneId }) => paneId), ["target"]);
  assert.deepEqual((await listTargets(runner, { status: "done" })).map(({ paneId }) => paneId).sort(), ["source", "target", "worker"]);
  assert.deepEqual(await listTargets(runner, { title: panes[1].label.toLowerCase() }), []);
});

function pane(paneId, label) {
  return { pane_id: paneId, terminal_id: `${paneId}-terminal`, workspace_id: "workspace", tab_id: "tab", label, agent_status: "done" };
}

/**
 * Returns a pane-list fake over caller-owned immutable test data.
 * Only pane reads are supported; each successful read increments `inventoryReads` so tests can
 * prove one-snapshot resolution. No Herdr or filesystem state is touched.
 */
function fakeRunner(items) {
  return {
    inventoryReads: 0,
    /**
     * Returns the configured pane inventory for a pane command and records the read count.
     * Unsupported command families return undefined; the supplied items are not copied or changed.
     */
    run: async function run(args) {
      if (args[0] !== "pane") return undefined;
      this.inventoryReads += 1;
      return { panes: items };
    },
  };
}
