/**
 * Exact terminal rendering profiles for the agent user interfaces this plugin drives.
 *
 * Delivery evidence is read from the visible pane, so every marker, separator,
 * placeholder and footer recorded here is an exact observed rendering. Nothing in this
 * module normalizes, trims or case-folds a message payload: profiles describe the
 * surrounding chrome only, and payload fragments keep being compared exactly.
 */

/**
 * Codex renders prompt entries with U+203A, queued entries with U+21B3 and separates the
 * marker from its content with one ASCII space. An empty composer always shows a
 * placeholder, so a bare marker is not a valid Codex entry.
 */
export const CODEX_PROFILE = {
  id: "codex",
  promptMarker: "›",
  queueMarker: "↳",
  separatorPattern: " ",
  allowBareMarker: false,
  continuationIndent: 2,
  tailEndsAtBorder: false,
  borderPattern: undefined,
  emptyComposerPatterns: [/^(?:Ask Codex|Ask Codex to do anything)$/u],
  ignoredTailPatterns: [/^gpt-[\w.-]+/u, /^tab to queue message(?:\s+\d+% context left)?$/u],
  blockingUiPattern:
    /(?:allow command|do you want to proceed|press enter to confirm|select an option|approval required)/iu,
};

/**
 * Claude Code renders prompt entries with U+276F inside a composer boxed by U+2500 rules.
 * The marker is followed by U+00A0, not by an ASCII space, and an idle composer shows
 * either the bare marker or one dimmed `Try "..."` suggestion. Everything printed below
 * the closing box border is mode chrome, never conversation activity.
 */
export const CLAUDE_PROFILE = {
  id: "claude",
  promptMarker: "❯",
  queueMarker: undefined,
  separatorPattern: "[\\u0020\\u00A0]",
  allowBareMarker: true,
  continuationIndent: 2,
  tailEndsAtBorder: true,
  borderPattern: /^─+$/u,
  emptyComposerPatterns: [/^$/u, /^Try "[^"]*"$/u],
  ignoredTailPatterns: [/^─+$/u, /^[⏵⏸]/u, /^\?\s+for shortcuts$/u],
  blockingUiPattern:
    /(?:allow command|do you want to proceed|press enter to confirm|select an option|approval required|waiting for permission|do you want to allow this connection)/iu,
};

/**
 * Gemini CLI renders prompts with an ASCII `>` inside a composer boxed by the half-block
 * rules U+2584 and U+2580. Typed content follows one ASCII space, the idle placeholder is
 * padded further, and wrapped lines are indented to the third column. A submitted message
 * keeps that same boxed shape in the transcript, so the live composer is the last entry.
 *
 * Because `>` is ordinary terminal punctuation, this profile relies on the composer box
 * rather than the marker alone: chrome scanning stops at the closing border.
 */
export const GEMINI_PROFILE = {
  id: "gemini",
  promptMarker: ">",
  queueMarker: undefined,
  separatorPattern: " ",
  allowBareMarker: false,
  continuationIndent: 3,
  tailEndsAtBorder: true,
  borderPattern: /^[▀▄]+$/u,
  emptyComposerPatterns: [/^\s*Type your message or @path\/to\/file$/u],
  ignoredTailPatterns: [
    /^[▀▄]+$/u,
    /^\?\s+for shortcuts$/u,
    /^(?:auto-accept edits|accepting edits|plan mode)/u,
  ],
  blockingUiPattern:
    /(?:allow command|do you want to proceed|press enter to confirm|select an option|approval required|allow execution|apply this change)/iu,
};

/**
 * Exact agent identifiers reported by Herdr, mapped to their rendering profile.
 *
 * Lookup is exact on purpose. An identifier that differs by case, spacing or spelling is
 * an unknown user interface, not a variant to canonicalize, and must fail closed rather
 * than be driven with another agent's markers.
 */
const PROFILES_BY_AGENT_ID = new Map([
  ["codex", CODEX_PROFILE],
  ["claude", CLAUDE_PROFILE],
  ["claude-code", CLAUDE_PROFILE],
  ["gemini", GEMINI_PROFILE],
]);

/**
 * Resolves the rendering profile for one exact Herdr agent identifier.
 *
 * Returns undefined for a missing, non-string or unsupported identifier so callers can
 * report an explicit unsupported target instead of writing into an unknown composer.
 */
export function resolveAgentProfile(agentId) {
  if (typeof agentId !== "string") return undefined;
  return PROFILES_BY_AGENT_ID.get(agentId);
}

/** Lists the exact agent identifiers this plugin can drive, for diagnostics and help text. */
export function supportedAgentIds() {
  return [...PROFILES_BY_AGENT_ID.keys()];
}
