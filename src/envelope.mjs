import { DEFAULT_PLUGIN_CONFIG, MAX_MESSAGE_UNITS, MIN_MESSAGE_UNITS } from "./config.mjs";
import { MAX_BODY_UNITS } from "./constants.mjs";

/** Durable transaction version that introduced the compact bracketed envelope. */
export const COMPACT_ENVELOPE_TRANSACTION_VERSION = 5;

/** Builds one exact visible envelope without changing any caller-provided string. */
export function serializeEnvelope(senderTitle, recipientTitle, body) {
  validateEnvelopeInput(senderTitle, recipientTitle, body);
  return `[${senderTitle}:${recipientTitle}] ${body}`;
}

/** Reconstructs the former visible envelope for already-admitted durable records only. */
export function serializeLegacyEnvelope(senderTitle, recipientTitle, body) {
  validateEnvelopeInput(senderTitle, recipientTitle, body);
  return `${senderTitle} | ${recipientTitle} : ${body}`;
}

/** Reconstructs the exact envelope contract owned by one persisted transaction version. */
export function serializeTransactionEnvelope(version, senderTitle, recipientTitle, body) {
  validateEnvelopeInput(senderTitle, recipientTitle, body);
  if (version === 4) return serializeLegacyEnvelope(senderTitle, recipientTitle, body);
  if (version === COMPACT_ENVELOPE_TRANSACTION_VERSION) return serializeEnvelope(senderTitle, recipientTitle, body);
  throw Object.assign(new Error("The durable transaction version has no supported envelope contract."), {
    code: "UNSUPPORTED_ENVELOPE_VERSION",
  });
}

/**
 * Splits one already serialized message into append-only composer chunks.
 *
 * The returned chunks preserve every UTF-16 unit and never split a Unicode code point.
 * They contain no transport markers because the daemon concatenates them in one composer
 * and submits the complete envelope once. The maximum is a plugin-local loading limit,
 * not a recipient-visible message boundary.
 */
export function createComposerChunks(payload, maximum = DEFAULT_PLUGIN_CONFIG.maxMessageUnits) {
  if (typeof payload !== "string" || payload.length === 0) {
    throw Object.assign(new Error("The serialized payload must be a non-empty exact string."), { code: "INVALID_INPUT" });
  }
  validateMaximum(maximum);
  const chunks = [];
  let chunk = "";
  for (const codePoint of Array.from(payload)) {
    if (chunk.length > 0 && chunk.length + codePoint.length > maximum) {
      chunks.push(chunk);
      chunk = "";
    }
    if (codePoint.length > maximum) {
      throw Object.assign(new Error("A Unicode code point cannot fit in one composer chunk."), { code: "CHUNK_TOO_LONG" });
    }
    chunk += codePoint;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** Validates exact endpoint labels and opaque body text before serialization. */
function validateEnvelopeInput(senderTitle, recipientTitle, body) {
  for (const [name, value] of [["sender title", senderTitle], ["recipient title", recipientTitle]]) {
    if (typeof value !== "string" || value.length === 0) {
      throw Object.assign(new Error(`The ${name} must be a non-empty exact string.`), { code: "INVALID_INPUT" });
    }
  }
  if (typeof body !== "string" || body.length === 0) {
    throw Object.assign(new Error("The message body must be a non-empty exact string."), { code: "INVALID_INPUT" });
  }
  if (body.includes("\r") || body.includes("\n")) {
    throw Object.assign(new Error("Line breaks are not supported because terminal wrapping must remain distinguishable from message content."), {
      code: "MULTILINE_BODY_UNSUPPORTED",
    });
  }
  if (body.length > MAX_BODY_UNITS) {
    throw Object.assign(new Error(`The message body exceeds ${MAX_BODY_UNITS} UTF-16 code units.`), { code: "BODY_TOO_LONG" });
  }
}

/** Validates the exact plugin-local chunk limit used for deterministic loading. */
function validateMaximum(maximum) {
  if (Number.isInteger(maximum) && maximum >= MIN_MESSAGE_UNITS && maximum <= MAX_MESSAGE_UNITS) return;
  throw Object.assign(
    new Error(`The message limit must be an integer between ${MIN_MESSAGE_UNITS} and ${MAX_MESSAGE_UNITS}.`),
    { code: "INVALID_LIMIT" },
  );
}
