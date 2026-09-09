## ADDED Requirements

### Requirement: Canonical URL and hostname equivalence
The scanner MUST normalize URLs for deduplication and MUST treat `www.` and non-`www.` hostnames as equivalent origins for scope decisions.

#### Scenario: Trailing slash canonicalization
- **WHEN** `https://example.com` and `https://example.com/` are evaluated
- **THEN** they MUST be treated as the same page identity for deduplication and budget accounting

#### Scenario: www/non-www host comparison
- **WHEN** a link transitions between `www.example.com` and `example.com`
- **THEN** hostname comparisons MUST consider them equivalent for in-scope decisions

### Requirement: Redirect boundary enforcement
The scanner MUST reject results that leave the queued hostname, including redirects that occur after initial navigation.

#### Scenario: Pre-scan redirect out of scope
- **WHEN** navigation resolves to a different hostname before scan execution
- **THEN** that page result MUST be discarded as out-of-scope

#### Scenario: Post-scan JavaScript redirect out of scope
- **WHEN** the page hostname changes during or after scan operations
- **THEN** the scanner MUST discard the result and MUST NOT count it as a successful in-scope scan

### Requirement: Entry URL identity preservation in custom flow
Custom-flow metadata MUST preserve the user-provided entry URL even if runtime navigation redirects elsewhere.

#### Scenario: Redirected entry in custom flow
- **WHEN** the first navigated page redirects
- **THEN** report metadata MUST retain the original user input as the entry URL identity

### Requirement: robots.txt disallow enforcement for dynamically discovered URLs
URLs discovered through interactive clicks, popups, or frame navigations MUST be checked against robots.txt rules before enqueue.

#### Scenario: Click-discovered URL blocked by robots.txt
- **WHEN** a URL is found via popup or interactive click that bypasses `transformRequestFunction`
- **THEN** the scanner MUST verify the URL against `isDisallowedInRobotsTxt` before enqueueing

### Requirement: robots.txt path pattern correctness
Bare disallow paths MUST generate both exact-path and children-glob patterns, and special characters MUST be escaped for pattern matching.

#### Scenario: Path generates exact and children patterns
- **WHEN** robots.txt contains `Disallow: /subscription/unsubscribe`
- **THEN** the scanner MUST produce both the exact-path pattern AND `/subscription/unsubscribe/**` for matching

#### Scenario: Query-string character escaping
- **WHEN** a robots.txt disallow path contains `?`
- **THEN** the `?` MUST be escaped before pattern matching since minimatch treats unescaped `?` as single-char wildcard