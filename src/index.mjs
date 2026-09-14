#!/usr/bin/env node
import { stdin } from "node:process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runDeliveryDaemon } from "./daemon.mjs";
import { ensurePluginConfig, loadPluginConfig, pluginConfigPath } from "./config.mjs";
import { CliHerdrRunner } from "./herdr.mjs";
import { listTargets } from "./identity.mjs";
import { formatTargetsHuman, parseOptions, requiredOption, requiredOptions } from "./cli-options.mjs";
import { acquireDaemonLease, ensureDaemon, getDaemonStatus, requestDaemonStop } from "./lifecycle.mjs";
import {
  cancelQueueEntry,
  enqueueReliableBatch,
  enqueueReliableMessage,
  getServiceStatus,
  listDeliveryReceipts,
  listReliableBatches,
  listQueueEntries,
  purgeQueueProofs,
  retryQueueEntry,
  showQueueEntry,
  showReliableBatch,
} from "./service.mjs";
import { resolveDataDirectory } from "./storage.mjs";
import { listDeliveryAlerts } from "./alerts.mjs";

const runner = new CliHerdrRunner();

/**
 * Dispatches one CLI invocation and emits exactly one JSON result, except human target output
 * and help text. Repeated `--to` values select atomic batch admission; one value preserves the
 * legacy transaction contract. Errors expose stable codes and body-free correction details.
 */
try {
  const [command = "help", ...args] = process.argv.slice(2);
  assertPluginEnabled(command, args);
  if (command === "send") {
    const options = parseOptions(args, {
      repeatable: new Set(["to"]),
      boolean: new Set(["stdin"]),
      allowed: new Set(["to", "stdin", "from", "message", "correlation"]),
    });
    if (options.stdin === true && Object.hasOwn(options, "message")) throw cliError("INVALID_ARGUMENT", "Use either --message or --stdin, not both.");
    const directory = await resolveDataDirectory();
    const config = await ensurePluginConfig(directory);
    const recipientTitles = requiredOptions(options, "to");
    const common = {
      senderPaneId: process.env.HERDR_PANE_ID,
      ...(typeof options.from === "string" ? { externalSenderLabel: options.from } : {}),
      body: options.stdin === true ? await readStandardInput() : requiredOption(options, "message"),
    };
    const result = recipientTitles.length === 1
      ? await enqueueReliableMessage(runner, {
        ...common,
        recipientTitle: recipientTitles[0],
        ...(typeof options.correlation === "string" ? { correlationId: options.correlation } : {}),
      }, { directory, config })
      : await enqueueReliableBatch(runner, {
        ...common,
        recipientTitles,
        ...(typeof options.correlation === "string" ? { batchCorrelationId: options.correlation } : {}),
      }, { directory, config });
    if (result.status === "DISCARDED") {
      print({ ...result, daemon: "NOT_REQUIRED" });
    } else {
      const daemonState = await ensureDaemonState(directory);
      print({ ...result, daemon: daemonState });
    }
    process.exitCode = 0;
  } else if (command === "start") {
    const directory = await resolveDataDirectory();
    await ensurePluginConfig(directory);
    const daemon = await ensureDaemon(directory, fileURLToPath(import.meta.url));
    print({ status: daemon.running ? "RUNNING" : "UNHEALTHY", ...(daemon.runtime ? { pid: daemon.runtime.pid, heartbeatAt: daemon.runtime.heartbeatAt } : {}) });
    process.exitCode = daemon.running ? 0 : 1;
  } else if (command === "daemon") {
    const directory = await resolveDataDirectory();
    const config = await ensurePluginConfig(directory);
    const lease = await acquireDaemonLease(directory);
    if (lease) {
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort());
      process.once("SIGTERM", () => controller.abort());
      try {
        await runDeliveryDaemon(runner, directory, lease, {
          signal: controller.signal,
          config,
          recipientConcurrency: config.recipientConcurrency,
        });
      } finally {
        await lease.release();
      }
    }
  } else if (command === "stop") {
    print(await requestDaemonStop(await resolveDataDirectory()));
  } else if (command === "targets") {
    const options = parseOptions(args, {
      boolean: new Set(["human"]),
      allowed: new Set(["title", "status", "human"]),
    });
    const targets = await listTargets(runner, {
      ...(typeof options.title === "string" ? { title: options.title } : {}),
      ...(typeof options.status === "string" ? { status: options.status } : {}),
    });
    if (options.human === true) process.stdout.write(formatTargetsHuman(targets));
    else print({ targets });
  } else if (command === "status") {
    const directory = await resolveDataDirectory();
    const config = await loadPluginConfig(directory);
    const [service, daemon] = await Promise.all([
      getServiceStatus(directory, { config }),
      getDaemonStatus(directory),
    ]);
    print({
      ...service,
      config: { path: pluginConfigPath(directory), ...config },
      daemon: daemon.running ? "RUNNING" : daemon.processAlive ? "UNHEALTHY" : "STOPPED",
      ...(daemon.runtime ? { daemonRuntime: daemon.runtime } : {}),
    });
  } else if (command === "queue") {
    print(await runQueueCommand(args));
  } else if (command === "receipts") {
    print(await runReceiptsCommand(args));
  } else if (command === "batch") {
    const [subcommand, ...rest] = args;
    if (subcommand !== "show") throw cliError("INVALID_ARGUMENT", "Usage: batch show <batch-correlation-id>");
    print(await showReliableBatch(requiredSingleArgument(rest, "batch show <batch-correlation-id>")));
  } else if (command === "alerts") {
    const [subcommand, ...rest] = args;
    if (subcommand !== "list" || rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) {
      throw cliError("INVALID_ARGUMENT", "Usage: alerts list [--all]");
    }
    print({ alerts: await listDeliveryAlerts(process.env.HERDR_PANE_ID, { all: rest[0] === "--all" }) });
  } else if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(helpText());
  } else {
    throw cliError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
  }
} catch (error) {
  print({
    status: "FAILED",
    code: typeof error?.code === "string" ? error.code : "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : "Unknown error",
    ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
  });
  process.exitCode = 1;
}

/**
 * Parses receipt queries for either individual transactions or batch aggregates.
 * Only the optional exact `--all` flag is accepted; reads remain body-free and sender-scoped
 * unless the local caller explicitly requests the global view.
 */
async function runReceiptsCommand(args) {
  const [subcommand, ...rest] = args;
  if (subcommand === "batches") {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) {
      throw cliError("INVALID_ARGUMENT", "Usage: receipts batches [--all]");
    }
    return { batches: await listReliableBatches(process.env.HERDR_PANE_ID, { all: rest[0] === "--all" }) };
  }
  if (subcommand !== "list" || rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) {
    throw cliError("INVALID_ARGUMENT", "Usage: receipts list [--all]");
  }
  return {
    receipts: await listDeliveryReceipts(runner, process.env.HERDR_PANE_ID, { all: rest[0] === "--all" }),
  };
}

async function runQueueCommand(args) {
  const [subcommand, ...rest] = args;
  const operatorPaneId = process.env.HERDR_PANE_ID;
  if (subcommand === "list") {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) throw cliError("INVALID_ARGUMENT", "Usage: queue list [--all]");
    return { entries: await listQueueEntries(runner, operatorPaneId, { includeTerminal: rest[0] === "--all" }) };
  }
  if (subcommand === "show") return showQueueEntry(runner, operatorPaneId, requiredSingleArgument(rest, "queue show <correlation-id>"));
  if (subcommand === "retry") {
    const directory = await resolveDataDirectory();
    const result = await retryQueueEntry(runner, operatorPaneId, requiredSingleArgument(rest, "queue retry <correlation-id>"), { directory });
    return { ...result, daemon: await ensureDaemonState(directory) };
  }
  if (subcommand === "cancel") return cancelQueueEntry(runner, operatorPaneId, requiredSingleArgument(rest, "queue cancel <correlation-id>"));
  if (subcommand === "purge") {
    if (rest.length !== 0) throw cliError("INVALID_ARGUMENT", "Usage: queue purge");
    return purgeQueueProofs(runner, operatorPaneId);
  }
  throw cliError("INVALID_ARGUMENT", "Usage: queue <list|show|retry|cancel|purge>");
}

function requiredSingleArgument(args, usage) {
  if (args.length !== 1 || args[0].length === 0) throw cliError("INVALID_ARGUMENT", `Usage: ${usage}`);
  return args[0];
}

async function readStandardInput() {
  let body = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) body += chunk;
  return body;
}

async function ensureDaemonState(directory) {
  try {
    const daemon = await ensureDaemon(directory, fileURLToPath(import.meta.url));
    return daemon.running ? "RUNNING" : "UNHEALTHY";
  } catch {
    // Durable queue ownership survives a daemon startup failure and can recover later.
    return "UNHEALTHY";
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function cliError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Prevents normal delivery commands while the experimental plugin is disabled. */
function assertPluginEnabled(command, args) {
  const disabledMarker = fileURLToPath(new URL("../DISABLED", import.meta.url));
  const mutatesDelivery = command === "send" || command === "start" || command === "daemon" ||
    (command === "queue" && args[0] === "retry");
  if (mutatesDelivery && existsSync(disabledMarker)) {
    throw cliError("PLUGIN_DISABLED", "Herdr reliable messaging is disabled. Use Herdr native messaging.");
  }
}

/**
 * Returns the role-neutral CLI contract, including repeatable targets and control-inbox reads.
 * It performs no runtime inspection or mutation and keeps exact-title requirements visible.
 */
function helpText() {
  return `Herdr Reliable Messaging\n\n` +
    `Usage:\n` +
    `  node src/index.mjs send [--from <external-label>] --to <exact-pane-title> [--to <exact-pane-title> ...] --message <body>\n` +
    `  <producer> | node src/index.mjs send [--from <external-label>] --to <exact-pane-title> --stdin\n` +
    `  node src/index.mjs queue list [--all]\n` +
    `  node src/index.mjs queue <show|retry|cancel> <correlation-id>\n` +
    `  node src/index.mjs queue purge\n` +
    `  node src/index.mjs receipts list [--all]\n` +
    `  node src/index.mjs receipts batches [--all]\n` +
    `  node src/index.mjs batch show <batch-correlation-id>\n` +
    `  node src/index.mjs alerts list [--all]\n` +
    `  node src/index.mjs targets [--title <exact-title>] [--status <exact-status>] [--human]\n` +
    `  node src/index.mjs <start|stop|status>\n`;
}
