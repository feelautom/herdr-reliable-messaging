---
name: herdr-reliable-messaging
description: Discover exact Herdr pane targets and send messages through the Herdr Reliable Messaging community plugin with durable admission, receipts, batches, and safe retry semantics. Use when an agent needs to communicate with another Herdr pane through this plugin.
---

# Herdr Reliable Messaging

Use this skill only when the `herdr-reliable-messaging` plugin is installed and
enabled. The plugin owns transport shaping, durable queuing, composer submission,
delivery verification, retries, and restart recovery. Callers provide one complete
body exactly once.

## Locate the plugin CLI

Resolve the managed plugin path instead of assuming a checkout location:

```powershell
$pluginEntry = (herdr plugin list --json | ConvertFrom-Json).result.plugins |
  Where-Object plugin_id -eq 'herdr-reliable-messaging' |
  Select-Object -First 1

if (-not $pluginEntry) {
  throw 'The herdr-reliable-messaging plugin is not installed.'
}

$messagingCli = Join-Path $pluginEntry.plugin_root 'src\index.mjs'
```

If the plugin is missing or disabled, report that state. Do not invent a path or
silently claim reliable delivery through another mechanism.

## Discover exact recipients

List live targets before sending when the exact visible title is not already known:

```powershell
node $messagingCli targets
node $messagingCli targets --status working --human
node $messagingCli targets --title '<exact pane title>'
```

Copy the returned `title` unchanged into `--to`. Never substitute a pane ID, role,
agent name, shortened title, case-insensitive match, or guessed spelling. Duplicate
exact titles are ambiguous and must be resolved by renaming the intended pane and
listing targets again.

## Send one complete body once

From a Herdr pane, preserve the genuine `HERDR_PANE_ID`:

```powershell
node $messagingCli send `
  --to '<exact pane title>' `
  --message '<single-line body>' `
  --correlation '<stable correlation>'
```

From a local process outside Herdr, do not fabricate `HERDR_PANE_ID`. Use a clear
external label instead:

```powershell
node $messagingCli send `
  --from '<external caller label>' `
  --to '<exact pane title>' `
  --message '<single-line body>' `
  --correlation '<stable correlation>'
```

Do not combine `--from` with a genuine `HERDR_PANE_ID`. Pass the body only; never add
the visible `[SOURCE:DESTINATION]` envelope, split the body, number chunks, press Enter
in the recipient pane, or reproduce the dispatcher's retry logic.

The body must be non-empty and contain no CR or LF. Preserve it exactly without
trimming, normalization, or case folding. A correlation is optional, but use a stable
task-local value when later inspection is needed. Never reuse a correlation for
different content or endpoints.

Interpret admission results precisely:

- `ACCEPTED` means the dispatcher durably owns the exact message. It does not mean
  delivery is complete. Never send it again or fall back blindly.
- `DISCARDED` with `SELF_MESSAGE_DISCARDED` is a successful terminal no-op. Do not retry.
- A rejected pre-admission request was not queued. Correct the reported input problem
  before considering a new send.
- If the command outcome is ambiguous, inspect the stable correlation before taking
  any action. Never assume absence or reinject the body.

## Send one body to several recipients

Repeat `--to` in one invocation:

```powershell
node $messagingCli send `
  --to '<exact pane title A>' `
  --to '<exact pane title B>' `
  --message '<single-line body>' `
  --correlation '<stable batch correlation>'
```

New batches are admitted atomically. A missing, repeated, ambiguous, or self-addressed
target rejects the entire new batch. After acceptance, each destination has its own
FIFO position, checkpoint, retries, and child receipt.

## Observe delivery

Use body-free status and receipt views whenever possible:

```powershell
node $messagingCli status
node $messagingCli queue list
node $messagingCli queue list --all
node $messagingCli receipts list
node $messagingCli receipts list --all
node $messagingCli receipts batches --all
node $messagingCli batch show <batch-correlation-id>
node $messagingCli alerts list
node $messagingCli alerts list --all
```

`receipts list` is scoped to the genuine calling pane. External processes use
`--all`. If later work strictly depends on delivery, inspect the exact correlation
until it reaches `DELIVERED`, `FAILED`, or `CANCELED`. Daemon health, elapsed time,
or batch acceptance alone is not delivery proof.

`queue show <correlation-id>` reveals the body of the exact selected active record.
Use it only when that disclosure is necessary. Queue mutations are intentional state
changes:

```powershell
node $messagingCli queue retry <correlation-id>
node $messagingCli queue cancel <correlation-id>
node $messagingCli queue purge
```

- `retry` wakes pending work without resetting composer checkpoints.
- `cancel` scrubs the body but cannot prove that an ambiguous prior submission was not
  received.
- `purge` removes terminal proof records. Do not use it as routine cleanup.

Unconfirmed messages expire five minutes after durable admission. Expiration is a
terminal failure, not proof of non-reception after an ambiguous submission. Never
automatically resend an expired body. The dispatcher never clears unrelated composer
content.

Do not start, stop, restart, link, unlink, enable, disable, install, or uninstall the
plugin merely because this skill was loaded. Perform those operations only when the
user explicitly asks for the corresponding state change.

## Compatibility boundary

The transport contract is independent of the language model: the model sees a prompt
only after its terminal UI submits it. Recipient automation still depends on terminal
UI behavior. The documented reproducible qualification covers Codex on Windows. The
maintainer has also used the plugin with Claude, but that use is not yet represented by
a public repeatable compatibility test. Treat other recipient TUIs as unqualified.
