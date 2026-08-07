## ADDED Requirements

### Requirement: Authorization header scoping
Authorization credentials MUST NOT be broadcast as global browser-context `extraHTTPHeaders`.

#### Scenario: Prevent cross-origin credential leakage
- **WHEN** a scan is configured with Authorization credentials
- **THEN** Authorization MUST be sent only to intended same-origin requests via scoped interception/navigation hooks

#### Scenario: Basic auth challenge handling
- **WHEN** credentials are Basic Auth compatible
- **THEN** the scanner MUST use browser `httpCredentials` for origin-aware challenge responses

### Requirement: Non-auth header rewrite minimization
Crawler pre-navigation header rewriting MUST only be enabled when non-empty shared headers are explicitly required.

#### Scenario: Unauthenticated scan without shared headers
- **WHEN** no non-auth headers are configured
- **THEN** request header rewriting MUST remain disabled to avoid unnecessary Playwright performance warnings

#### Scenario: Authenticated scan with shared headers
- **WHEN** non-auth shared headers are configured alongside auth credentials
- **THEN** header rewriting MUST be enabled and the expected Playwright header-rewrite warning is acceptable

### Requirement: Connectivity-check header isolation
Connectivity probing MUST avoid mutating shared crawl header objects.

#### Scenario: Local Accept injection only
- **WHEN** URL connectivity checks require an `Accept` header
- **THEN** the scanner MUST add it to a local header copy and MUST NOT mutate the shared crawler `extraHTTPHeaders` object

### Requirement: Common preNavigationHooks for auth header delivery
Auth headers MUST be delivered through a shared hook used by all crawlers to prevent inconsistent auth behavior across scan types.

#### Scenario: Consistent auth delivery across domain and sitemap crawls
- **WHEN** an authenticated scan runs in either domain or sitemap mode
- **THEN** both crawler types MUST use the same `preNavigationHooks` implementation for header injection