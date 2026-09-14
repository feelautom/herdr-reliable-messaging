import test from "node:test";
import assert from "node:assert/strict";
import { createComposerChunks, serializeEnvelope, serializeTransactionEnvelope } from "../src/envelope.mjs";

const SOURCE = "AUTHOR";
const TARGET = "REVIEWER";

test("serializes the exact endpoint titles and body", () => {
  const body = "  Keep exact spacing Ω  ";
  assert.equal(serializeEnvelope(SOURCE, TARGET, body), `[${SOURCE}:${TARGET}] ${body}`);
});

test("preserves colons inside exact titles without parsing the visible envelope", () => {
  assert.equal(
    serializeEnvelope("SOURCE:ALPHA", "TARGET:BETA", "Exact body"),
    "[SOURCE:ALPHA:TARGET:BETA] Exact body",
  );
});

test("preserves the legacy envelope only for durable version-four recovery", () => {
  const body = "Legacy queued body";
  assert.equal(serializeTransactionEnvelope(4, SOURCE, TARGET, body), `${SOURCE} | ${TARGET} : ${body}`);
  assert.equal(serializeTransactionEnvelope(5, SOURCE, TARGET, body), `[${SOURCE}:${TARGET}] ${body}`);
  assert.throws(
    () => serializeTransactionEnvelope(3, SOURCE, TARGET, body),
    (error) => error.code === "UNSUPPORTED_ENVELOPE_VERSION",
  );
});

test("splits one serialized envelope into exact composer-loading chunks", () => {
  const payload = serializeEnvelope(SOURCE, TARGET, "exact payload block ".repeat(80));
  const chunks = createComposerChunks(payload, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.equal(chunks.join(""), payload);
  assert.ok(chunks.every((chunk) => !endsWithHighSurrogate(chunk)));
  assert.ok(chunks.every((chunk) => !startsWithLowSurrogate(chunk)));
});

test("uses an explicit chunk limit without changing exact payload reconstruction", () => {
  const payload = serializeEnvelope(SOURCE, TARGET, "configurable composer payload ".repeat(30));
  const compact = createComposerChunks(payload, 300);
  const wide = createComposerChunks(payload, 500);
  assert.ok(compact.length > wide.length);
  assert.equal(compact.join(""), payload);
  assert.equal(wide.join(""), payload);
  assert.ok(compact.every((chunk) => chunk.length <= 300));
  assert.ok(wide.every((chunk) => chunk.length <= 500));
});

test("rejects real line breaks so visual wrapping remains reversible", () => {
  assert.throws(
    () => serializeEnvelope(SOURCE, TARGET, "first line\nsecond line"),
    (error) => error.code === "MULTILINE_BODY_UNSUPPORTED",
  );
});

function endsWithHighSurrogate(value) {
  if (value.length === 0) return false;
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function startsWithLowSurrogate(value) {
  if (value.length === 0) return false;
  const code = value.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}
