## ADDED Requirements

### Requirement: Successful-page budget enforcement
The crawler MUST enforce `maxRequestsPerCrawl` based on successfully scanned pages, not on attempted requests or enqueued URLs.

#### Scenario: Failed pages do not consume scan budget
- **WHEN** a request fails or is discarded before becoming a successful scan result
- **THEN** the crawler MUST NOT decrement or consume a `maxRequestsPerCrawl` success slot

#### Scenario: Last slot is claimed at success point
- **WHEN** a page is about to be added to the successful scanned-pages set
- **THEN** the crawler MUST claim the slot synchronously at that success point and only abort after the last slot is actually claimed

### Requirement: Adaptive concurrency under HTTP rate limiting
The crawler MUST reduce pressure on targets that respond with HTTP 4xx/5xx by adapting concurrency downward and MUST recover concurrency after sustained successes.

#### Scenario: Concurrency reduction on server rejection
- **WHEN** consecutive HTTP 4xx/5xx responses are observed
- **THEN** concurrency MUST be reduced by halving, with a lower bound of 1

#### Scenario: Concurrency recovery on stable success
- **WHEN** 10 consecutive successful scans occur after a degraded period
- **THEN** concurrency MUST increase by 2 toward the original configured level

### Requirement: Consecutive-failure circuit breaker
The crawler MUST stop gracefully when HTTP 4xx/5xx failures reach a configured consecutive threshold to avoid unbounded scans on blocked targets.

#### Scenario: Abort on threshold breach
- **WHEN** consecutive HTTP 4xx/5xx failures reach `OOBEE_CONSECUTIVE_MAX_RETRIES` (default 100)
- **THEN** the crawler MUST abort and continue with artifact generation instead of running indefinitely

### Requirement: Only HTTP status errors trigger rate adaptation
Timeouts, DNS failures, and other network-level errors MUST NOT trigger concurrency adaptation or increment the circuit breaker counter.

#### Scenario: Timeout does not degrade concurrency
- **WHEN** a request fails due to network timeout or connection error
- **THEN** the crawler MUST NOT reduce concurrency or count the failure toward the consecutive-failure threshold