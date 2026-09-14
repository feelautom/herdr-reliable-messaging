/** Stable plugin identifier used by Herdr and local storage resolution. */
export const PLUGIN_ID = "herdr-reliable-messaging";

/** Maximum accepted source body length, preventing unbounded local work. */
export const MAX_BODY_UNITS = 100_000;

/** Earliest durable deadline for the next independent delivery observation. */
export const OBSERVATION_DELAY_MS = 200;

/** Maximum controlled Enter,Enter gestures for one exact fully staged message. */
export const MAX_SUBMIT_ATTEMPTS = 2;

/** Delay between durable queue scans by the background daemon. */
export const DAEMON_POLL_INTERVAL_MS = 500;

/** Heartbeat cadence for the single detached daemon process. */
export const DAEMON_HEARTBEAT_INTERVAL_MS = 2_000;

/** Maximum heartbeat age accepted as evidence of a healthy daemon. */
export const DAEMON_HEARTBEAT_STALE_MS = 10_000;

/** Initial delay before retrying a transaction whose delivery is not yet proven. */
export const RETRY_BASE_DELAY_MS = 500;

/** Maximum retry delay, keeping recovery responsive without busy polling. */
export const RETRY_MAX_DELAY_MS = 5_000;

/** Maximum number of active messages accepted into the durable queue. */
export const MAX_PENDING_TRANSACTIONS = 1_000;

/** Firm lifetime from durable admission; retries, queue position and restart never extend it. */
export const MAX_PENDING_AGE_MS = 300_000;

/** Maximum aggregate UTF-16 body units retained by active queue entries. */
export const MAX_PENDING_BODY_UNITS = 50_000_000;
