//! Shared OKX rate-limit handling: response classification, `Retry-After`
//! parsing, backoff ladders, and the private-REST request pacing.
//!
//! Before this module the same three rules existed in three places that
//! disagreed with each other: the intelligence collector parsed `Retry-After`
//! with a 5s/15s ladder, the public REST path retried a fixed 2.2s, and the
//! private REST path had no pacing at all and failed the caller on the first
//! throttled response. OKX counts limits per endpoint *and* per User ID, so a
//! private-REST burst can be throttled by traffic this process did not send.

use super::*;

/// OKX answers throttling with HTTP 429 and/or code 50011.
pub(crate) const OKX_CODE_RATE_LIMITED: &str = "50011";

/// Default ladder for a throttled request, in milliseconds. OKX windows are two
/// seconds wide, so the first step only has to clear the current window.
const RATE_LIMIT_FALLBACK_MS: [u64; 2] = [700, 1_600];
/// Ceiling for callers that must stay responsive. A collector that can afford a
/// longer cooldown passes its own.
const RATE_LIMIT_MAX_DELAY_MS: u64 = 5_000;
const RATE_LIMIT_MIN_DELAY_MS: u64 = 200;
const RATE_LIMIT_JITTER_MS: u64 = 150;
/// True when a response was rejected for exceeding the rate limit. Matched on
/// the body text because every caller receives it as a `String`.
pub(crate) fn is_rate_limited(status: reqwest::StatusCode, body: &str) -> bool {
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return true;
    }
    okx_error_fields(body).is_some_and(|(code, message)| {
        code == OKX_CODE_RATE_LIMITED || message.to_ascii_lowercase().contains("too many requests")
    })
}

/// `Retry-After` in seconds, when the response carried a usable value.
pub(crate) fn retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

/// Wait before retrying a throttled request: `Retry-After` wins, then `ladder`,
/// always jittered. `max_ms` is the caller's own ceiling, because an interactive
/// request and a background collector tolerate very different cooldowns.
pub(crate) fn backoff_ms(
    retry_after_seconds: Option<u64>,
    attempt: u32,
    ladder: &[u64],
    max_ms: u64,
) -> u64 {
    let base = retry_after_seconds
        .map(|seconds| seconds.saturating_mul(1_000))
        .unwrap_or_else(|| {
            if ladder.is_empty() {
                RATE_LIMIT_FALLBACK_MS[0]
            } else {
                ladder[(attempt as usize).min(ladder.len() - 1)]
            }
        });
    let jitter = now_ms().unsigned_abs() % RATE_LIMIT_JITTER_MS;
    base.saturating_add(jitter)
        .clamp(RATE_LIMIT_MIN_DELAY_MS, max_ms.max(RATE_LIMIT_MIN_DELAY_MS))
}

/// Backoff with the default ladder, for callers that do not carry their own.
pub(crate) fn default_backoff_ms(retry_after_seconds: Option<u64>, attempt: u32) -> u64 {
    backoff_ms(
        retry_after_seconds,
        attempt,
        &RATE_LIMIT_FALLBACK_MS,
        RATE_LIMIT_MAX_DELAY_MS,
    )
}

// ---------------------------------------------------------------------------
// Private REST request pacing
// ---------------------------------------------------------------------------

/// Documented OKX budgets. Archive endpoints allow 5 requests / 2 seconds per
/// User ID (`/api/v5/account/bills-archive`), which is the strictest window the
/// history backfill touches, so its pacing sets the archive interval.
const ARCHIVE_MIN_INTERVAL_MS: u64 = 400;
const QUERY_MIN_INTERVAL_MS: u64 = 200;
const DEFAULT_PRIVATE_INTERVAL_MS: u64 = 250;
/// Requests in flight at once. The backfill is sequential, so this only bounds
/// a background worker racing an interactive refresh.
const PRIVATE_REST_MAX_CONCURRENT: usize = 2;
/// A single wait never exceeds this. A longer queue would rather surface a
/// failed request than stall an interactive read behind a backfill.
const PRIVATE_REST_MAX_WAIT_MS: u64 = 1_500;

#[derive(Default)]
struct PrivateRestPacing {
    archive: OnceLock<AsyncMutex<Instant>>,
    query: OnceLock<AsyncMutex<Instant>>,
    default: OnceLock<AsyncMutex<Instant>>,
}

fn private_rest_pacing() -> &'static PrivateRestPacing {
    static PACING: OnceLock<PrivateRestPacing> = OnceLock::new();
    PACING.get_or_init(PrivateRestPacing::default)
}

fn private_rest_semaphore() -> &'static Semaphore {
    static SEMAPHORE: OnceLock<Semaphore> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Semaphore::new(PRIVATE_REST_MAX_CONCURRENT))
}

/// Which documented budget a private path spends. Archive first: an archive
/// endpoint is also a `*-history` path.
fn private_rest_family(path: &str) -> (&'static AsyncMutex<Instant>, &'static str, u64) {
    let pacing = private_rest_pacing();
    let route = path.split('?').next().unwrap_or(path);
    if route.ends_with("-archive") {
        return (
            pacing
                .archive
                .get_or_init(|| AsyncMutex::new(Instant::now() - Duration::from_millis(ARCHIVE_MIN_INTERVAL_MS))),
            "archive",
            ARCHIVE_MIN_INTERVAL_MS,
        );
    }
    if route.ends_with("-history") {
        return (
            pacing
                .query
                .get_or_init(|| AsyncMutex::new(Instant::now() - Duration::from_millis(QUERY_MIN_INTERVAL_MS))),
            "history",
            QUERY_MIN_INTERVAL_MS,
        );
    }
    (
        pacing
            .default
            .get_or_init(|| AsyncMutex::new(Instant::now() - Duration::from_millis(DEFAULT_PRIVATE_INTERVAL_MS))),
        "default",
        DEFAULT_PRIVATE_INTERVAL_MS,
    )
}

/// Reserves a private-REST slot: waits for the path's family to clear its
/// minimum interval, then returns a permit that must live for the whole
/// request. Each family is paced independently, and the lock is held across the
/// wait so concurrent callers queue instead of arriving together.
pub(crate) async fn acquire_private_rest_slot(
    path: &str,
) -> Result<SemaphorePermit<'static>, String> {
    let (gate, _family, interval_ms) = private_rest_family(path);
    let permit = private_rest_semaphore()
        .acquire()
        .await
        .map_err(|err| format!("OKX Private REST 限速器不可用: {err}"))?;
    let minimum = Duration::from_millis(interval_ms);
    let mut previous = gate.lock().await;
    let elapsed = previous.elapsed();
    let mut waited_ms = 0_u64;
    if elapsed < minimum {
        let wait = (minimum - elapsed).min(Duration::from_millis(PRIVATE_REST_MAX_WAIT_MS));
        waited_ms = wait.as_millis() as u64;
        sleep(wait).await;
    }
    *previous = Instant::now();
    record_pacing(waited_ms);
    Ok(permit)
}

/// Per-run observation of what a paced phase cost. The history backfill runs on
/// one task, so it can attribute its own requests; `boot.log` prints this to
/// separate "not throttled" from "throttled and waited it out".
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub(crate) struct PrivateRestPacingReport {
    pub requests: u64,
    pub waits: u64,
    pub waited_ms: u64,
}

thread_local! {
    static PACING_REPORT: std::cell::Cell<PrivateRestPacingReport> =
        const { std::cell::Cell::new(PrivateRestPacingReport { requests: 0, waits: 0, waited_ms: 0 }) };
}

fn record_pacing(waited_ms: u64) {
    let _ = PACING_REPORT.try_with(|report| {
        let current = report.get();
        report.set(PrivateRestPacingReport {
            requests: current.requests.saturating_add(1),
            waits: current.waits.saturating_add(u64::from(waited_ms > 0)),
            waited_ms: current.waited_ms.saturating_add(waited_ms),
        });
    });
}

/// Returns what this thread's phase spent so far and starts a fresh count.
pub(crate) fn take_private_rest_pacing() -> PrivateRestPacingReport {
    PACING_REPORT
        .try_with(|report| report.replace(PrivateRestPacingReport::default()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers_with_retry_after(value: &str) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_str(value).expect("header value"),
        );
        headers
    }

    #[test]
    fn only_throttling_responses_are_rate_limits() {
        assert!(is_rate_limited(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            ""
        ));
        assert!(is_rate_limited(
            reqwest::StatusCode::OK,
            r#"{"code":"50011","msg":"Too Many Requests"}"#
        ));
        // 50013 is "系统繁忙", a different failure: its message must not be read
        // as throttling even when it happens to mention rate limits.
        assert!(!is_rate_limited(
            reqwest::StatusCode::OK,
            r#"{"code":"50013","msg":"System busy. Rate limit reached elsewhere."}"#
        ));
        assert!(!is_rate_limited(
            reqwest::StatusCode::NOT_FOUND,
            "<html>404</html>"
        ));
        assert!(!is_rate_limited(reqwest::StatusCode::OK, ""));
    }

    #[test]
    fn retry_after_is_read_only_from_a_usable_header() {
        assert_eq!(retry_after_seconds(&headers_with_retry_after("2")), Some(2));
        assert_eq!(
            retry_after_seconds(&headers_with_retry_after("  3 ")),
            Some(3)
        );
        assert_eq!(retry_after_seconds(&headers_with_retry_after("soon")), None);
        assert_eq!(retry_after_seconds(&reqwest::header::HeaderMap::new()), None);
    }

    #[test]
    fn backoff_prefers_retry_after_and_stays_bounded() {
        let ladder = [700_u64, 1_600_u64];
        let from_header = backoff_ms(Some(2), 0, &ladder, RATE_LIMIT_MAX_DELAY_MS);
        assert!(
            (2_000..=2_150).contains(&from_header),
            "Retry-After must drive the wait, got {from_header}ms"
        );
        let first = backoff_ms(None, 0, &ladder, RATE_LIMIT_MAX_DELAY_MS);
        let second = backoff_ms(None, 1, &ladder, RATE_LIMIT_MAX_DELAY_MS);
        assert!((700..=850).contains(&first), "first step, got {first}ms");
        assert!((1_600..=1_750).contains(&second), "second step, got {second}ms");
        assert!(backoff_ms(Some(999), 0, &ladder, RATE_LIMIT_MAX_DELAY_MS) <= RATE_LIMIT_MAX_DELAY_MS);
        assert!(backoff_ms(None, 9, &ladder, RATE_LIMIT_MAX_DELAY_MS) >= 1_600);
        let floor = backoff_ms(Some(0), 0, &ladder, RATE_LIMIT_MAX_DELAY_MS);
        assert!((RATE_LIMIT_MIN_DELAY_MS..=350).contains(&floor), "floor, got {floor}ms");
        // An empty ladder still produces a usable wait instead of panicking.
        assert!(backoff_ms(None, 0, &[], RATE_LIMIT_MAX_DELAY_MS) >= RATE_LIMIT_MIN_DELAY_MS);
        // A caller's own ceiling is respected, and one below the floor cannot
        // collapse the wait to zero.
        assert!(backoff_ms(None, 1, &[5_000, 15_000], 15_000) >= 15_000);
        assert!(backoff_ms(None, 1, &[5_000, 15_000], 15_000) <= 15_150);
        assert!(backoff_ms(None, 0, &ladder, 100) >= RATE_LIMIT_MIN_DELAY_MS);
    }

    #[test]
    fn archive_paths_get_the_strict_archive_interval() {
        let (_, family, interval) = private_rest_family(
            "/api/v5/account/bills-archive?limit=100&instType=SWAP",
        );
        assert_eq!(family, "archive");
        assert_eq!(interval, ARCHIVE_MIN_INTERVAL_MS);
        let (_, family, interval) = private_rest_family("/api/v5/trade/orders-history-archive?limit=100");
        assert_eq!(family, "archive", "an archive path is also a *-history path");
        assert_eq!(interval, ARCHIVE_MIN_INTERVAL_MS);
        let (_, family, interval) = private_rest_family("/api/v5/account/positions-history");
        assert_eq!(family, "history");
        assert_eq!(interval, QUERY_MIN_INTERVAL_MS);
        let (_, family, interval) = private_rest_family("/api/v5/account/balance");
        assert_eq!(family, "default");
        assert_eq!(interval, DEFAULT_PRIVATE_INTERVAL_MS);
    }

    #[tokio::test]
    async fn the_same_family_is_paced_but_other_families_are_not_blocked() {
        let paced_path = "/api/v5/account/bills-archive?limit=1";
        let started = Instant::now();
        {
            let _first = acquire_private_rest_slot(paced_path)
                .await
                .expect("first slot");
        }
        {
            let _second = acquire_private_rest_slot(paced_path)
                .await
                .expect("second slot");
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed >= Duration::from_millis(ARCHIVE_MIN_INTERVAL_MS),
            "two runs of the same family must be spaced, took {elapsed:?}"
        );

        // A different family is paced by its own clock, so it pays only its own
        // (shorter) interval rather than queueing behind the archive gate.
        let other_started = Instant::now();
        let _other = acquire_private_rest_slot("/api/v5/account/balance")
            .await
            .expect("other family slot");
        assert!(
            other_started.elapsed() < Duration::from_millis(ARCHIVE_MIN_INTERVAL_MS),
            "an unrelated family must not wait for the archive gate"
        );
    }
}
