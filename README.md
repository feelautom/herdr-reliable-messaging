# Herdr Reliable Messaging

A community Herdr plugin for durable, deterministic message delivery between named panes on Windows.

Herdr Reliable Messaging was created to make automated long-prompt delivery dependable when native terminal input can leave text staged in a Codex composer without submitting it. It accepts a message once, stores it durably, loads it into the target composer in verified chunks, submits it once, and records a body-free delivery receipt.

This is a terminal transport and integration problem, not a language-model problem: the model does not receive the prompt until the terminal UI submits it. Delivery evidence is therefore read from the recipient's visible composer, and each recipient interface needs its own rendering profile. Codex, Claude Code, and Gemini CLI are supported in every direction, each covered by automated regressions. Senders may be any named Herdr pane or an explicitly labeled local process.

> [!IMPORTANT]
> This is an independent community project provided **as is**. It is not an official Herdr plugin and comes with no support, maintenance, roadmap, compatibility, or response-time commitment. Fork it, adapt it, or maintain your own version under the MIT license.

## Supported agent user interfaces

Delivery reads the visible composer of the target pane, so each agent needs its exact rendering profile. The plugin selects that profile from the exact `agent` identifier Herdr reports for the pane:

| Agent identifier | Interface | Prompt marker | Composer shape |
| --- | --- | --- | --- |
| `codex` | Codex CLI | `›` with `↳` for queued entries | inline, `Ask Codex` placeholder |
| `claude`, `claude-code` | Claude Code | `❯` followed by U+00A0 | boxed with `─` rules |
| `gemini` | Gemini CLI | ASCII `>` | boxed with U+2584 and U+2580 rules |

A pane running any other agent, or no recognized agent, stays pending with `TARGET_AGENT_UNSUPPORTED` and is never written into with foreign markers. Adding an agent means adding one profile in `src/agent-profiles.mjs`: its markers, marker separator, continuation indent, empty-composer placeholders, chrome to ignore, and blocking approval patterns. Message payloads are compared exactly in every profile, without trimming, case folding, or Unicode normalization.

## What it provides

- Exact routing by visible Herdr pane title.
- Durable acceptance before delivery begins.
- FIFO ordering within each destination.
- Concurrent progress across different destinations.
- Restart-safe composer loading without blind body reinjection.
- One final visible message even when several internal chunks are required.
- Deterministic delivery evidence based on composer clearance and a positive receipt signal.
- Body-free asynchronous receipts and operational diagnostics.
- Multi-recipient batch admission.
- Explicit external sender labels for processes running outside Herdr.
- Five-minute expiry for unconfirmed messages so one ambiguous delivery cannot block a destination forever.

The plugin uses Herdr's public CLI and does not replace or patch the `herdr` executable.

## Requirements

- Windows
- Herdr 0.8.2 or newer
- Node.js 22 or newer
- Codex recipient panes launched normally through your Herdr workflow

The plugin has no npm package dependencies and does not require `npm install`.

## Install from GitHub

Once the repository is public, install and enable it with:

```powershell
herdr plugin install FeelAutom/herdr-reliable-messaging
herdr plugin enable herdr-reliable-messaging
```

Herdr manages the installed checkout. To locate the plugin CLI from PowerShell:

```powershell
$plugin = (herdr plugin list --json | ConvertFrom-Json).result.plugins |
  Where-Object plugin_id -eq 'herdr-reliable-messaging' |
  Select-Object -First 1

$messagingCli = Join-Path $plugin.plugin_root 'src\index.mjs'
```

The examples below assume `$messagingCli` contains that path.

For local development, clone the repository and link it instead:

```powershell
herdr plugin link C:\path\to\herdr-reliable-messaging --enabled
$messagingCli = 'C:\path\to\herdr-reliable-messaging\src\index.mjs'
```

## Install the bundled Codex skill

The repository includes a portable usage skill at
`skills/herdr-reliable-messaging`. It teaches Codex how to discover the managed
plugin path, resolve exact pane titles, submit each body once, and interpret durable
acceptance and receipts without unsafe fallback or blind reinjection.

Ask Codex to install that skill from the GitHub repository path, or copy the complete
directory into your Codex skills directory as `herdr-reliable-messaging`. The skill
becomes available to new Codex turns after installation. Installing the skill does not
install, enable, start, or restart the Herdr plugin.

## Discover destinations

```powershell
node $messagingCli targets
node $messagingCli targets --status working --human
node $messagingCli targets --title 'REVIEWER'
```

Every live pane with a usable single-line title can send and receive. Titles are matched exactly: the plugin does not trim, case-fold, normalize, or guess them. Duplicate titles are rejected with deterministic rename suggestions.

## Send a message

From a Herdr pane, `HERDR_PANE_ID` identifies the sender:

```powershell
node $messagingCli send `
  --to 'REVIEWER' `
  --message 'Review the current checkpoint.' `
  --correlation 'review-1'
```

From a process outside Herdr, omit `HERDR_PANE_ID` and provide a display label:

```powershell
node $messagingCli send `
  --from 'LOCAL AUTOMATION' `
  --to 'REVIEWER' `
  --message 'Run the requested check.'
```

External identities are displayed with an `EXTERNAL` prefix. Supplying both `HERDR_PANE_ID` and `--from` is rejected as ambiguous.

The visible message format is:

```text
[SENDER PANE TITLE:RECIPIENT PANE TITLE] message
```

The colon is presentation syntax only. Structured endpoint fields remain authoritative, so titles may themselves contain colons.

Message bodies must be single-line strings. CR and LF characters are rejected because Codex also visually wraps long prompts; keeping authored line breaks separate from visual wrapping is necessary for exact reconstruction. Send separate messages for separate paragraphs.

`--correlation` is optional. Reusing a correlation for different content or endpoints is rejected before admission.

## Send to several panes

Repeat `--to` to admit one body atomically for several exact destinations:

```powershell
node $messagingCli send `
  --to 'REVIEWER A' `
  --to 'REVIEWER B' `
  --to 'REVIEWER C' `
  --message 'Run the same bounded check.' `
  --correlation 'shared-check-1'
```

A missing, repeated, ambiguous, or self-addressed target rejects the complete new batch before delivery. Each accepted child then has its own FIFO position, retry state, checkpoint, and receipt.

## Delivery model

`send` writes the exact body to durable plugin state before returning `ACCEPTED`. A background dispatcher then:

1. selects the oldest eligible message for each destination;
2. requires a safe composer state;
3. persists the intended next offset;
4. appends and verifies bounded internal chunks without pressing Enter;
5. verifies the complete composer twice;
6. submits the complete visible message once;
7. requires repeated composer-clearance and positive receipt evidence before recording `DELIVERED`.

The dispatcher never clears unrelated composer content. If delivery becomes ambiguous, it preserves the checkpoint and avoids blind reinjection. Self-addressed pane messages are terminally discarded and are never queued or retried.

Unconfirmed messages expire five minutes after durable admission. Expiry never clears the target UI and never claims that an ambiguously submitted message was definitely lost.

## Queue and receipts

```powershell
node $messagingCli queue list
node $messagingCli queue list --all
node $messagingCli queue show <correlation-id>
node $messagingCli queue retry <correlation-id>
node $messagingCli queue cancel <correlation-id>
node $messagingCli queue purge
node $messagingCli status
```

`queue list` never exposes bodies. `queue show` returns the body only for the explicitly named active record. `queue purge` removes terminal proof records only and never active messages.

Read the 50 newest body-free receipts for the calling pane, or for all local callers:

```powershell
node $messagingCli receipts list
node $messagingCli receipts list --all
node $messagingCli batch show shared-check-1
node $messagingCli receipts batches --all
```

Failed or unusually old transactions may also create a separate body-free anomaly notice:

```powershell
node $messagingCli alerts list
node $messagingCli alerts list --all
```

Successful delivery does not generate an alert.

## Configuration and data

Runtime files live in Herdr's private plugin configuration directory. `settings.json` supports:

| Setting | Range | Default | Purpose |
| --- | ---: | ---: | --- |
| `maxMessageUnits` | 64–4000 | 500 | Maximum UTF-16 units per internal composer append. |
| `recipientConcurrency` | 1–16 | 4 | Destination heads allowed to progress concurrently. |
| `pendingAlertAgeMs` | 10 seconds–7 days | 5 minutes | Age that triggers a pending-health notice. |
| `pendingAlertCount` | 1–1000 | 25 | Pending count that triggers a health notice. |

Pending transactions temporarily retain their exact bodies. Terminal records and diagnostics are body-free. Terminal proof retention is bounded to 30 days and the newest 1,000 records. The active queue is capped at 1,000 messages and 50,000,000 UTF-16 body units.

For an isolated test, set `HERDR_RELIABLE_MESSAGING_DATA_DIR` to a dedicated temporary directory on the intended drive.

## Known limitations

- Windows only.
- The language model itself is not part of the transport contract.
- Reproducible recipient validation covers the Codex TUI on Windows. The maintainer has also used Claude, but no public repeatable Claude compatibility test is included yet.
- Depends on Herdr and Codex terminal behavior that may change between releases.
- Exact delivery proof is conservative; ambiguous outcomes can fail even when the recipient may have received the message.
- Bodies must be single-line strings.
- GitHub-managed installs must locate the CLI through `herdr plugin list --json` as shown above.
- No support or maintenance commitment is provided.

## Development

```powershell
npm test
```

The current suite contains 111 automated tests covering durable admission, FIFO scheduling, concurrent destinations, recovery, expiration, exact endpoint identity, multi-recipient batches, alerts, receipts, storage bounds, and failure semantics.

Real validation should use isolated Herdr panes so active work is not disturbed.

## License

[MIT](LICENSE) © 2026 FeelAutom.
