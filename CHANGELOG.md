# Changelog

## 0.7.0 — 2026-09-06

- Expire every unconfirmed data message five minutes after its original durable admission.
- Bound native Herdr calls by the remaining message lifetime.
- Preserve ambiguous receipt and composer evidence without blind replay or speculative UI cleanup.
- Expose body-free expiration evidence in queue, receipt, batch, and alert results.

## 0.6.0 — 2026-09-04

- Adopt the compact `[SOURCE:DESTINATION] message` envelope.
- Add exact target discovery and atomic multi-recipient admission.
- Add grouped batch receipts and body-free anomaly feedback.
- Preserve compatible version-4 transactions during restart recovery.

## 0.5.0 — 2026-08-31

- Replace visible multipart messages with one durable FIFO dispatcher.
- Load one complete visible message through bounded internal composer chunks.
- Preserve FIFO within each destination while advancing different destinations concurrently.
- Add restart-safe checkpoint reconciliation and conservative delivery proof.
- Allow delivery to writable working panes while preserving composer and blocking-UI guards.
- Add body-free asynchronous receipts and explicit self-message discard.

## Earlier development

- Added durable one-call acceptance, target pinning, correlation idempotency, and bounded retries.
- Made sender identity role-neutral and added explicit external caller labels.
