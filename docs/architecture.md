# Herdr Reliable Messaging Architecture

## Context and boundary

The plugin targets Herdr 0.8.2 on Windows and uses only its public CLI: `pane list`, `pane send-text`, `agent get`, `agent read`, and `agent send-keys`. It neither patches Herdr nor creates panes. Herdr may leave submitted text in the Codex composer, so a successful CLI return is never treated as delivery proof. This occurs in terminal input handling before the language model receives a prompt; it is not a model-level failure. The transport is model-agnostic when the same supported terminal agent is used. Recipient TUI behavior is currently qualified only for Codex on Windows because composer and receipt evidence depends on Codex-visible markers.

Herdr's `[[startup]]` hook invokes `start`. `start` ensures one detached Node daemon. The daemon owns its process lease and heartbeat. Every `send` also ensures the daemon after durable acceptance, so a temporary start failure cannot invalidate an accepted queue entry.

## Identity and exact strings

- Inside Herdr, `HERDR_PANE_ID` must resolve to exactly one live pane; its exact visible title becomes the sender identity.
- Outside Herdr, the caller supplies an exact single-line label, persisted and displayed as `EXTERNAL <label>` without fabricating a pane identifier.
- Every live named pane may send or receive; routing does not classify roles.
- Titles, labels, identifiers, and bodies are compared exactly without trimming, case folding, or Unicode normalization.
- The complete visible payload is `[SENDER TITLE:RECIPIENT TITLE] body`. The colon is presentation syntax and is never parsed; structured endpoint fields remain authoritative even when a title contains a colon.
- CR/LF input is rejected so authored line breaks cannot be confused with visual terminal wrapping.

## Durable FIFO admission

`send` serializes the complete payload, computes exact fingerprints, and atomically writes a version-5 `PENDING` transaction before returning `ACCEPTED`. A short internal state critical section allocates a monotonically increasing queue sequence and prevents concurrent producers from losing or replacing entries. It is not a caller-owned claim, reservation, or destination lock.

Before admission, a pane message addressed to the same exact pane is returned as terminal `DISCARDED` with `SELF_MESSAGE_DISCARDED`. No transaction file is created, the daemon is not awakened, and no retryable failure is exposed.

Each pending record contains the exact body, complete-payload fingerprint, internal chunk fingerprints and lengths, endpoint identity, arrival sequence, scheduler deadline, and one composer checkpoint. Terminal records retain body-free evidence; the exact body is removed in the same atomic terminal rewrite.

Version 0.6.0 adds strict multi-recipient admission while preserving single-recipient tolerance for a temporarily absent title. A duplicate live title now fails synchronously on both paths with exact body-free candidates and rename suggestions; it is never admitted as an ambiguous FIFO head. Repeated `--to` values are resolved from one fresh pane inventory. Duplicate, absent, ambiguous, or self-addressed titles reject the complete new batch. The plugin builds a body-free manifest plus one independent durable child per destination in a private staging directory, then publishes the complete set with one directory rename. A crash before that rename exposes no child to the dispatcher. Single correlations, batch correlations, and derived child correlations share one collision-free namespace. The batch correlation and exact ordered title list derive fixed-length child correlations; idempotent replay returns the same children or fails on any changed exact input.

Every child retains its own active body because independent restart recovery and atomic terminal scrubbing remain the primary safety boundary. Queue capacity therefore counts the body once per child. Retention treats a batch as one proof group and never deletes only part of its aggregate history.

The target may be absent at admission. Before loading starts, the dispatcher waits for exactly one matching title and pins its pane, terminal, workspace, tab, and title. If that pin disappears after any composer content was loaded, the transaction fails closed as an ambiguous target loss and is never silently redirected.

## Dispatcher loop

The daemon is one deadline-driven event loop. On every scan it sorts pending records
by durable arrival sequence and expires every stale entry, including followers, before
choosing the oldest remaining record for each exact destination. It filters those fresh
heads by their retry time and advances independent heads up to the configured limit.

The immutable lifetime is `createdAt + 300000 ms`. A retry, restart, queue wait or
successful observation does not extend it. `processTransactionPath` rereads under its
transaction lock and checks expiry before `nextAttemptAt`, legacy protocol validation,
target resolution or injection. Each Herdr call is checked before and after its await
and receives the remaining lifetime as its subprocess timeout. Late evidence cannot
become delivery success; already-issued native effects remain ambiguous.

Expiration atomically scrubs the body into `FAILED / DELIVERY_EXPIRED`, preserving
the prior code and checkpoint alongside `expiresAt`, `expiredAt`, `receiptOutcome` and
`composerState`. A submitted message has `receiptOutcome: UNKNOWN`, not proof of loss.
An invalid or absent admission date fails closed as `PENDING_CREATED_AT_INVALID`.
Supported and incompatible legacy records with valid dates expire using their original
age before any resume attempt; a fresh incompatible record still fails its protocol gate.

No expiration path touches the UI. `POSSIBLE_ORPHAN_PRESERVED` records possible residual
content after append/submission. Existing exact composer guards prevent followers from
mixing into visible residual or third-party text; a blocked follower expires independently.
The scheduler only removes a stale candidate from its in-memory lane after terminal
readback/write succeeds. Concurrent cancellation or delivery under the same lock wins
without being overwritten. Terminal records remain stable and use existing proof retention.

The deadline is policy enforced by scans and guarded calls, not a hard real-time OS
guarantee: downtime, lock/I/O failure and an already-issued native effect cannot be undone.
Restart does not purge the queue or reset its age. After approved rollout, the first scan
expires old messages; fresh messages can progress when the actual composer is writable.
Alert creation is separate and is not a prerequisite for the authoritative terminal write.

This provides:

- lossless concurrent admission from any number of producers;
- strict FIFO delivery eligibility within one destination, with independent expiry of stale followers;
- independent progress across different destinations;
- continued admission while active transactions are loading or waiting for evidence;
- no caller or agent ownership protocol.

## One-composer loading protocol

The dispatcher splits the complete serialized payload into code-point-safe internal chunks, defaulting to at most 500 UTF-16 units. These chunks are transport operations, not visible messages.

For each transaction the state machine:

1. observes the target and requires an empty composer or the exact already-loaded prefix;
2. persists the intended next offset;
3. appends one chunk with `pane send-text`, without Enter;
4. verifies the exact accumulated composer prefix on a later tick and persists progress;
5. repeats until the complete payload is loaded;
6. verifies the complete composer twice;
7. persists the submission attempt and sends `Enter`, `Enter` once;
8. requires two later observations of composer clearance plus a newly visible exact receipt before marking `DELIVERED`.

### Agent rendering profiles

Composer evidence is read from the visible pane, so it depends on the target agent's exact terminal rendering. Each supported agent has one profile in `src/agent-profiles.mjs` declaring its prompt marker, optional queue marker, marker separator, continuation indent, empty-composer placeholders, chrome to ignore, and blocking approval patterns. `advanceComposerMessage` selects the profile from the exact `agent` identifier Herdr reports for the target pane.

Codex renders prompts with `›`, queued entries with `↳`, one ASCII space after the marker, and an `Ask Codex` placeholder in an idle composer. Claude Code renders prompts with `❯` followed by U+00A0 inside a composer boxed by `─` rules; an idle composer shows the bare marker or one dimmed `Try "..."` suggestion, and everything printed below the closing border is mode chrome rather than conversation activity. Gemini CLI renders prompts inside a composer boxed by the half-block rules U+2584 and U+2580, pads its idle placeholder, and repeats that same boxed shape for each submitted message, so the live composer remains the last entry. Its marker depends on the approval mode: `>` in the default and auto-accept modes, `*` once YOLO mode is enabled, and both are accepted.

Each profile also declares its continuation indent, which is the width the agent reserves for its marker: two columns for Codex and Claude Code, three for Gemini CLI. Wrapped lines are reassembled from that indent, so a visually wrapped message is compared against the exact payload without reflowing or normalizing it.

Profile lookup is exact. An identifier that differs by case, spacing, or spelling is an unknown user interface, so an unrecognized or absent agent yields `TARGET_AGENT_UNSUPPORTED` and no write, instead of driving a foreign composer with another agent's markers. Profiles describe surrounding chrome only: payload fragments are still compared exactly, without trimming, case folding, or Unicode normalization.

Herdr status `working` is eligible for append and submission because the supported agents queue or steer input received during an active turn. Eligibility does not replace evidence: the composer must still be empty or contain the transaction's exact confirmed prefix, and blocking approval UI remains forbidden. `blocked` and unknown states remain pending without a write. Stable footers such as Codex's `tab to queue message` line, or the mode line printed below a boxed composer, are treated as chrome rather than post-composer activity.

If the process stops between persistence and append confirmation, the next scan distinguishes the previous prefix from the intended new prefix and never appends that chunk twice. If the complete text remains staged after submission, only bounded submission retries are allowed. Unrelated composer text is never overwritten or appended to.

Version-5 transactions reconstruct the compact bracketed envelope. Version-4 transactions reconstruct the former `SENDER TITLE | RECIPIENT TITLE : body` envelope so already-admitted work and exact correlation replay remain valid across an upgrade. Version-2 control alerts use the compact envelope while version-1 alerts retain the former envelope during recovery. Data versions 1 through 3 remain incompatible and fail closed.

A confirmed non-zero prefix that later disappears is never treated as permission to load it again. Two consecutive empty observations while the pinned target is writable produce `FAILED_AMBIGUOUS_COMPOSER_LOST`; terminalization scrubs the body and releases the destination lane. Exact prefix reappearance clears the loss counter, while blocked and unknown targets preserve the checkpoint without accumulating loss evidence. This policy prefers an explicit ambiguous failure over a possible duplicate caused by an external submission or composer clear.

An accepted append may appear after a later Herdr observation. Its intent therefore starts a persisted reconciliation window while the previous exact prefix is still visible. Fresh reads must preserve that exact prior prefix for at least five seconds before the transaction terminalizes as `FAILED_AMBIGUOUS_APPEND_LOST`, scrubs its body, and releases the lane rather than waiting forever or risking a duplicate append. Exact appearance of the intended prefix clears that evidence and advances the checkpoint without another write. Blocked and unknown targets reset append-loss timing. If an older runtime lost the intent field but the exact next prefix is already present, the checkpoint also advances without another write. When Codex scrolls the beginning of a long composer out of its internal viewport, an exact visible suffix may confirm the intended end only after earlier prefix units were durably confirmed.

After submission, bounded detection is checked first. If a long prompt has left that viewport, the daemon checks deeper recent history for the exact payload. It also captures Herdr lifecycle counters immediately before submission from `idle` or `done`; subsequent counter progress is causal evidence only from that settled baseline. Composer clearance plus positive receipt evidence must still be observed twice.

## Queue operations, recovery, and cleanup

`queue list [--all]` is body-free. `queue show <id>` returns the body only for that exact active record. `queue retry <id>` changes scheduling metadata without resetting composer progress. `queue cancel <id>` scrubs the body and reports ambiguity after any loading or submission attempt. `queue purge` removes terminal proofs only.

`receipts list` derives the 50 newest body-free summaries whose persisted sender pane ID exactly matches the current `HERDR_PANE_ID`. `receipts list --all` exposes the same bounded global view to a local external process. Both commands read existing transaction records at query time; they create no callback message, secondary log, or hot-path write.

`batch show` and `receipts batches [--all]` derive aggregate state from the manifest's exact children. The result includes counts and per-destination summaries without active bodies. Exact child correlations remain usable with ordinary queue controls.

## Separate anomaly control inbox

All control lanes share a one-second wall-clock native-call budget per drain. The
remaining budget bounds every Herdr subprocess, including target pin verification,
snapshots, history, append and submission. Deadline checks also run after rejected
calls. Exhaustion returns to the daemon's next data scan with persisted append/submit
intent intact; no detached promise releases a lock while a native writer still runs.
The subsequent scan observes the exact checkpoint rather than blindly replaying it.
The budget does not clear UI, cancel receipts or weaken positive delivery evidence.
Filesystem/lock failures retain their existing fail-closed behavior and are not a
hard real-time guarantee; the bound specifically prevents native alert calls from
indefinitely starving data expiration.

Newly admitted transactions carry an explicit sender-notification policy. Terminal failure or an over-age pending state creates one deduplicated body-free alert in `alerts/`, outside `transactions/` and outside every destination FIFO lane. Records from older versions do not opt in, preventing an upgrade from producing a historical alert burst.

For a pinned pane sender, the daemon advances the oldest alert for that sender through the same exact composer verification state machine used by data delivery. It never clears, interrupts, or appends to unrelated composer content. The visible source is `EXTERNAL HERDR RELIABLE MESSAGING`; no pane identity is fabricated. A recovered stuck transaction cancels an alert that was not yet shown. External callers retain a local-only alert because no return pane exists. Success produces no alert. The control inbox is hard-capped at 1,000 records; authoritative transaction receipts remain available if an additional best-effort notice cannot be admitted. Terminal alert proofs are pruned after 30 days or beyond the newest 1,000; active notices are never pruned.

Version-1, version-2, and version-3 pending records use incompatible composer protocols and fail closed as `LEGACY_PENDING_UNRESUMABLE`; no old staged text is guessed or replayed. Active capacity is 1,000 messages and 50,000,000 UTF-16 body units. Terminal proofs are retained for 30 days, capped at the newest 1,000. Abandoned atomic-write temporary files older than one hour are removed. Diagnostics rotate by size and never contain message bodies or terminal snapshots.

Pending-health thresholds are plugin-local and backward compatible with pre-existing settings files. The status view reports count, age, threshold reasons, and the oldest head's exact correlation, destination, sequence, timestamps, and stable code without its body. The daemon records only material alert and recovery transitions, so a permanently unhealthy lane is visible without producing one log line per poll. A daemon restart may emit one fresh alert as explicit new-process evidence.

## Validation boundary

Automated tests cover exact string semantics, configurable chunk sizing, concurrent lossless admission, durable arrival ordering, independent destination progress, strict per-destination FIFO, arrivals during active loading, delayed append recovery, scrolled composer suffixes, deep receipt history, causal lifecycle evidence, restart recovery without duplicate append, single final submission, bounded retry, self-message discard, target pinning, role-neutral callers, queue management, terminal body scrubbing, stale temporary cleanup, internal state serialization, and daemon lease ownership.

Real Herdr validation uses isolated panes so active work panes remain out of scope. Version 0.5.0 passed a four-pane matrix in which every instance sent one long message to each of the other three: 12/12 delivered, every payload loaded in three or four internal chunks, exactly one submission per message, zero failure, zero pending entry, and four empty composers.

A follow-up delivered one externally attributed prompt while Herdr continued to report the Codex pane as `working`. The transaction resumed after a daemon restart, recognized the real queue footer, reached `DELIVERY_CONFIRMED` with one loaded chunk and one submission attempt, and the recipient later confirmed that it received the prompt during the active analysis.

Regression coverage includes a loaded checkpoint or pending append whose expected composer text disappears, exact-prefix reappearance, blocked and unknown targets, body-free ambiguous terminalization, follower FIFO release, configurable pending-health thresholds, and deduplicated daemon alerts. Isolated Herdr validation proves ambiguous heads fail without reinjection or submission while followers continue. Discarded legacy queue entries remain body-free and terminal.

Target discovery and batch validation cover exact filters, atomic three-recipient admission, deterministic replay, independent destination progress, grouped retention, body-free aggregate receipts, and the separate deduplicated anomaly control channel.
