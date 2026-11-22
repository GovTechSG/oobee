## ADDED Requirements

### Requirement: Retry-safe failed-request accounting
Scan error records MUST be emitted only after crawler retry exhaustion to avoid duplicates and false positives.

#### Scenario: Intermediate request-handler exception
- **WHEN** a request fails but still has remaining retries
- **THEN** the scanner MUST NOT record it as a final failed URL entry yet

#### Scenario: Retries exhausted
- **WHEN** Crawlee invokes final failed-request handling after all retries
- **THEN** the scanner MUST record the error exactly once in failed results

### Requirement: Report-generation stability on Windows lock races
Report generation MUST tolerate late Crawlee lock-file operations that can surface EPERM errors on Windows after crawl completion.

#### Scenario: Late lock-file EPERM during artifact phase
- **WHEN** scoped Windows EPERM lock race errors occur during report generation
- **THEN** the process MUST suppress those known non-fatal exceptions and continue artifact generation

### Requirement: Graceful dataset cleanup ordering
Temporary Crawlee data MUST be removed in a cleanup sequence that preserves zip/report correctness.

#### Scenario: Cleanup before zipping
- **WHEN** artifact generation is finalizing outputs
- **THEN** dataset and intermediate temporary stores MUST be cleaned before zipping, with awaited delays to allow pending I/O flushes

#### Scenario: Dataset drop uses Crawlee API
- **WHEN** the crawler dataset needs disposal
- **THEN** `dataset.drop()` MUST be used for graceful storage cleanup instead of raw filesystem deletion

### Requirement: Corruption-tolerant intermediate JSONL store
Intermediate per-rule JSONL item storage MUST serialize writes and tolerate malformed historical lines during reads.

#### Scenario: Concurrent append attempts
- **WHEN** multiple issue writes target the same rule file
- **THEN** appends MUST be serialized to prevent interleaved JSONL corruption

#### Scenario: Malformed historical JSONL line
- **WHEN** readback encounters invalid legacy lines
- **THEN** reader logic MUST skip malformed entries and continue processing remaining valid records

#### Scenario: Control character sanitization
- **WHEN** website HTML inputs contain literal newline or carriage-return control characters
- **THEN** the JSONL writer MUST sanitize these immediately after `JSON.stringify()` to prevent illegal implicit line boundaries

### Requirement: Page lifecycle-safe metadata and rule verification
Scan-time metadata capture and post-axe false-positive mitigation MUST account for dynamic page state changes.

#### Scenario: Title capture before page instability
- **WHEN** `runAxeScript()` starts on a live page
- **THEN** `document.title` MUST be captured before operations that may close or navigate the page

#### Scenario: aria-hidden-focus race revalidation
- **WHEN** `aria-hidden-focus` findings may be affected by delayed `tabindex` updates
- **THEN** the scanner MUST re-verify live DOM focusability after yielding to the event loop and filter false positives accordingly

### Requirement: Browser profile isolation and cleanup
Each scan MUST use a cloned browser profile to avoid cross-scan state pollution and MUST clean up after completion.

#### Scenario: Profile cloning with unique token
- **WHEN** a new scan starts
- **THEN** browser profiles MUST be cloned with the scan's `randomToken` suffix into isolated directories

#### Scenario: Pool re-launch profile uniqueness on Windows
- **WHEN** Crawlee retires and re-launches browser instances during a scan
- **THEN** each re-launch MUST use a unique `_pool{N}` directory to avoid Chrome exit code 21 from stale lock contention

#### Scenario: Profile clone failure fallback
- **WHEN** Chrome/Edge profile cloning fails (e.g., `EBUSY` on Windows)
- **THEN** the scanner MUST fall back to an empty cloned profile directory rather than crashing