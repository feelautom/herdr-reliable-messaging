import { listPanes } from "./herdr.mjs";

const MAX_EXTERNAL_LABEL_UNITS = 120;

/**
 * Returns whether a value can identify one pane by its exact visible Herdr title.
 *
 * Titles are preserved exactly: no trimming, case folding, or Unicode normalization
 * is applied. Line breaks are rejected because the transport envelope is single-line.
 */
export function isValidPaneTitle(title) {
  return typeof title === "string" && title.length > 0 && !/[\r\n]/u.test(title);
}

/**
 * Resolves exact live pane endpoints without classifying either endpoint by role.
 * Both identities come from one fresh pane inventory and self-targeting is rejected.
 * Missing, changed, duplicated, or invalid endpoints fail with stable coded errors.
 */
export async function resolveEndpoints(runner, senderPaneId, recipientTitle) {
  const sender = await resolvePaneSender(runner, senderPaneId);
  const recipient = await resolveRecipientByTitle(runner, recipientTitle);
  if (recipient.pane_id === sender.pane_id) {
    throw endpointError("TARGET_IS_SOURCE", "The source and recipient panes must be different.");
  }
  return { sender, recipient };
}

/**
 * Resolves one live Herdr pane as a sender without imposing a role or naming convention.
 *
 * The opaque pane identifier must come from Herdr. A missing identifier is never
 * replaced with a fabricated pane identity; external callers supply a visible label.
 */
export async function resolvePaneSender(runner, senderPaneId) {
  if (typeof senderPaneId !== "string" || senderPaneId.length === 0) {
    throw endpointError("SOURCE_UNAVAILABLE", "HERDR_PANE_ID is missing; provide an explicit external sender label.");
  }
  const matches = (await listPanes(runner)).filter((pane) => pane.pane_id === senderPaneId);
  if (matches.length !== 1) throw endpointError("SOURCE_CHANGED", "The source pane is unavailable or ambiguous.");
  if (!isValidPaneTitle(matches[0].label)) throw endpointError("SOURCE_INVALID", "The source pane has no usable exact title.");
  return matches[0];
}

/**
 * Resolves a sender from either a live Herdr pane or an explicit external label.
 *
 * Exactly one origin mechanism is accepted. External labels retain their exact spelling
 * and receive a visible prefix so they cannot masquerade as a live pane.
 */
export async function resolveMessageSender(runner, { paneId, externalLabel } = {}) {
  const hasPane = typeof paneId === "string" && paneId.length > 0;
  const hasExternal = externalLabel !== undefined;
  if (hasPane && hasExternal) {
    throw endpointError("SOURCE_CONFLICT", "Do not combine HERDR_PANE_ID with an external sender label.");
  }
  if (hasPane) return pinPane(await resolvePaneSender(runner, paneId));
  return createExternalSender(externalLabel);
}

/**
 * Lists live panes with exact usable titles and optional exact title/status filters.
 *
 * One authoritative inventory is read. Invalid single-line labels are omitted, filters do
 * not trim, fold case, or normalize Unicode, and sorting is display-only. Invalid filter
 * types fail with `TARGET_FILTER_INVALID`; this read-only operation persists no state.
 */
export async function listTargets(runner, options = {}) {
  if (options.title !== undefined && typeof options.title !== "string") {
    throw endpointError("TARGET_FILTER_INVALID", "The title filter must be an exact string.");
  }
  if (options.status !== undefined && typeof options.status !== "string") {
    throw endpointError("TARGET_FILTER_INVALID", "The status filter must be an exact string.");
  }
  return (await listPanes(runner))
    .filter((pane) => isValidPaneTitle(pane.label))
    .map((pane) => ({ paneId: pane.pane_id, title: pane.label, status: pane.agent_status }))
    .filter((target) => options.title === undefined || target.title === options.title)
    .filter((target) => options.status === undefined || target.status === options.status)
    .sort((left, right) => left.title.localeCompare(right.title, "en", { sensitivity: "variant" }));
}

/**
 * Resolves several exact recipient titles from one authoritative Herdr inventory.
 *
 * The caller retains ordering. Missing and ambiguous titles fail before any durable
 * admission and expose only exact body-free pane metadata suitable for correction.
 */
export async function resolveRecipientsByTitles(runner, recipientTitles) {
  if (!Array.isArray(recipientTitles) || recipientTitles.length === 0) {
    throw endpointError("TARGET_INVALID", "At least one exact recipient pane title is required.");
  }
  return resolveRecipientsFromPanes(await listPanes(runner), recipientTitles);
}

/**
 * Resolves a pane or explicit external sender and every exact batch recipient atomically.
 *
 * One Herdr inventory supplies all pane identities, so callers cannot combine observations
 * from different snapshots. Source conflicts, missing/ambiguous targets, invalid titles, and
 * self-addressing fail before persistence. Returned pane records remain live-inventory values.
 */
export async function resolveBatchEndpoints(runner, { paneId, externalLabel, recipientTitles } = {}) {
  const panes = await listPanes(runner);
  const hasPane = typeof paneId === "string" && paneId.length > 0;
  const hasExternal = externalLabel !== undefined;
  if (hasPane && hasExternal) {
    throw endpointError("SOURCE_CONFLICT", "Do not combine HERDR_PANE_ID with an external sender label.");
  }
  let sender;
  if (hasPane) {
    const matches = panes.filter((pane) => pane.pane_id === paneId);
    if (matches.length !== 1) throw endpointError("SOURCE_CHANGED", "The source pane is unavailable or ambiguous.");
    if (!isValidPaneTitle(matches[0].label)) throw endpointError("SOURCE_INVALID", "The source pane has no usable exact title.");
    sender = pinPane(matches[0]);
  } else {
    sender = createExternalSender(externalLabel);
  }
  const recipients = resolveRecipientsFromPanes(panes, recipientTitles);
  if (sender.kind === "pane" && recipients.some((recipient) => recipient.pane_id === sender.paneId)) {
    throw endpointError("TARGET_IS_SOURCE", "A batch recipient must differ from its source pane.");
  }
  return { sender, recipients };
}

/**
 * Confirms that a pinned endpoint pair still denotes the same live panes.
 * A fresh Herdr inventory is read and every opaque location field plus title must match.
 */
export async function verifyPinnedEndpoints(runner, endpoints) {
  const panes = await listPanes(runner);
  return matchesPin(panes, endpoints.sender) && matchesPin(panes, endpoints.recipient);
}

/**
 * Confirms that one pinned pane still denotes the same exact live terminal.
 * Herdr command failures propagate so the caller can distinguish outage from replacement.
 */
export async function verifyPinnedPane(runner, pin) {
  return matchesPin(await listPanes(runner), pin);
}

/**
 * Resolves one exact live pane title for safe pre-injection retargeting.
 * Comparison is ordinal and normalization-free. Absent and duplicate titles remain
 * distinct errors with body-free correction metadata; the caller decides whether an
 * unavailable target is transient, while ambiguity must never select a pane implicitly.
 */
export async function resolveRecipientByTitle(runner, recipientTitle) {
  return (await resolveRecipientsByTitles(runner, [recipientTitle]))[0];
}

/**
 * Pins every live-pane identity field needed to detect replacement without role inference.
 * The returned plain object is persisted with a transaction and owns no live resource.
 */
export function pinPane(pane) {
  return {
    kind: "pane",
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    workspaceId: pane.workspace_id,
    tabId: pane.tab_id,
    title: pane.label,
  };
}

/**
 * Builds a visible, non-pane identity for a process running outside Herdr.
 * Labels must already be canonical for display: non-empty, unpadded, control-free,
 * single-line, and at most 120 UTF-16 units. Valid spelling and Unicode representation
 * are preserved.
 */
export function createExternalSender(label) {
  if (typeof label !== "string" || label.length === 0 || label.length > MAX_EXTERNAL_LABEL_UNITS ||
      label.trim() !== label || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(label)) {
    throw endpointError("EXTERNAL_SOURCE_INVALID", `An exact external sender label of 1-${MAX_EXTERNAL_LABEL_UNITS} single-line units is required.`);
  }
  return { kind: "external", externalLabel: label, title: `EXTERNAL ${label}` };
}

/**
 * Compares persisted sender identities exactly while retaining version-2 pane compatibility.
 * External origins compare their kind, label, and visible title; pane origins compare
 * their opaque pane identifier and title, including records created before `kind` existed.
 */
export function sameSenderIdentity(left, right) {
  if (left?.kind === "external" || right?.kind === "external") {
    return left?.kind === "external" && right?.kind === "external" &&
      left.externalLabel === right.externalLabel && left.title === right.title;
  }
  return left?.paneId === right?.paneId && left?.title === right?.title;
}

/**
 * Tests one pinned pane against a fresh Herdr inventory without normalizing opaque fields.
 * Returns false rather than mutating or retargeting the pin when any field differs.
 */
function matchesPin(panes, pin) {
  return panes.some((pane) =>
    pane.pane_id === pin.paneId &&
    pane.terminal_id === pin.terminalId &&
    pane.workspace_id === pin.workspaceId &&
    pane.tab_id === pin.tabId &&
    pane.label === pin.title,
  );
}

/**
 * Applies ordered, exact batch-title resolution to a caller-owned pane snapshot.
 *
 * Each requested title must identify exactly one pane. Failures contain only body-free exact
 * candidate metadata; rename values are deterministic suggestions and never routing choices.
 */
function resolveRecipientsFromPanes(panes, recipientTitles) {
  return recipientTitles.map((title) => {
    if (!isValidPaneTitle(title)) {
      throw endpointError("TARGET_INVALID", "Every batch recipient must be an exact single-line pane title.");
    }
    const matches = panes.filter((pane) => pane.label === title);
    if (matches.length === 1) return matches[0];
    const candidates = matches.map((pane) => ({ paneId: pane.pane_id, title: pane.label, status: pane.agent_status }));
    if (matches.length === 0) {
      throw endpointError("TARGET_UNAVAILABLE", "No live pane has one requested exact title.", { title, candidates });
    }
    const suggestedRenames = candidates.map((candidate) => ({
      paneId: candidate.paneId,
      suggestedTitle: `${candidate.title} ${candidate.paneId}`,
    }));
    throw endpointError("TARGET_AMBIGUOUS", "Several live panes have one requested exact title.", { title, candidates, suggestedRenames });
  });
}

/**
 * Creates a stable identity error with optional body-free structured correction details.
 * The caller decides whether to display the details; no logging or persistence occurs here.
 */
function endpointError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}
