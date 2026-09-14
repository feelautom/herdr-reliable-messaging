/**
 * Parses long CLI options while preserving exact authored values and repeatable order.
 * Allowed-name, missing-value, and duplicate-scalar violations fail with `INVALID_ARGUMENT`.
 * No trimming, case folding, Unicode normalization, filesystem access, or mutation occurs.
 */
export function parseOptions(args, options = {}) {
  const repeatable = options.repeatable || new Set();
  const boolean = options.boolean || new Set();
  const allowed = options.allowed;
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw cliOptionError("INVALID_ARGUMENT", `Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (allowed && !allowed.has(name)) throw cliOptionError("INVALID_ARGUMENT", `Unknown option: --${name}.`);
    if (boolean.has(name)) {
      if (Object.hasOwn(result, name)) throw cliOptionError("INVALID_ARGUMENT", `Duplicate option: --${name}.`);
      result[name] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw cliOptionError("INVALID_ARGUMENT", `Missing value for --${name}.`);
    if (repeatable.has(name)) {
      result[name] = [...(result[name] || []), value];
    } else {
      if (Object.hasOwn(result, name)) throw cliOptionError("INVALID_ARGUMENT", `Duplicate option: --${name}.`);
      result[name] = value;
    }
    index += 1;
  }
  return result;
}

/**
 * Returns one required exact scalar string without normalization.
 * Missing or non-scalar values fail with `INVALID_ARGUMENT`; the options object is not changed.
 */
export function requiredOption(options, name) {
  if (typeof options[name] !== "string") throw cliOptionError("INVALID_ARGUMENT", `Missing required option --${name}.`);
  return options[name];
}

/**
 * Returns required repeated exact option values in authored order without copying or rewriting.
 * A missing or empty list fails with `INVALID_ARGUMENT`; item validation belongs to the caller.
 */
export function requiredOptions(options, name) {
  if (!Array.isArray(options[name]) || options[name].length === 0) {
    throw cliOptionError("INVALID_ARGUMENT", `Missing required option --${name}.`);
  }
  return options[name];
}

/**
 * Renders target discovery as stable body-free tab-separated lines for human reuse.
 * JSON escaping keeps exact titles on one physical line; the input order and objects are unchanged.
 */
export function formatTargetsHuman(targets) {
  return ["STATUS\tPANE ID\tEXACT TITLE", ...targets.map((target) => (
    `${target.status ?? "unknown"}\t${target.paneId}\t${JSON.stringify(target.title)}`
  ))].join("\n") + "\n";
}

/**
 * Creates one stable CLI parsing failure from an explicit code and message.
 * It does not log, print, normalize values, or mutate parser state.
 */
function cliOptionError(code, message) {
  return Object.assign(new Error(message), { code });
}
