import test from "node:test";
import assert from "node:assert/strict";
import { formatTargetsHuman, parseOptions, requiredOptions } from "../src/cli-options.mjs";

/** Proves repeated destinations preserve authored order and exact Unicode representation. */
test("parses repeated --to values without normalization", () => {
  const options = parseOptions(["--to", "TARGET A", "--to", "Å", "--to", "A\u030a", "--message", "body"], {
    repeatable: new Set(["to"]),
  });
  assert.deepEqual(requiredOptions(options, "to"), ["TARGET A", "Å", "A\u030a"]);
  assert.equal(options.message, "body");
});

/** Proves non-repeatable options and duplicate boolean filters still fail explicitly. */
test("rejects duplicate scalar and boolean options", () => {
  assert.throws(() => parseOptions(["--message", "one", "--message", "two"]), (error) => error.code === "INVALID_ARGUMENT");
  assert.throws(() => parseOptions(["--human", "--human"], { boolean: new Set(["human"]) }), (error) => error.code === "INVALID_ARGUMENT");
  assert.throws(() => parseOptions(["--guess", "value"], { allowed: new Set(["title"]) }), (error) => error.code === "INVALID_ARGUMENT");
});

/** Proves human discovery keeps exact titles escaped on one deterministic line. */
test("formats exact target titles for human reuse", () => {
  const output = formatTargetsHuman([{ status: "working", paneId: "w1:p2", title: "ORCH | CHEF" }]);
  assert.equal(output, "STATUS\tPANE ID\tEXACT TITLE\nworking\tw1:p2\t\"ORCH | CHEF\"\n");
});
