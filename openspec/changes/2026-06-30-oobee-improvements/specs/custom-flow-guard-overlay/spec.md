## ADDED Requirements

### Requirement: Safe fallback validation before URL guard restore
URL guard recovery MUST validate fallback URL protocol safety before performing forced navigation.

#### Scenario: file-scheme fallback is rejected
- **WHEN** the configured safe fallback resolves to a non-HTTP(S) protocol such as `file://`
- **THEN** guard recovery MUST NOT call `page.goto()` to that fallback URL

### Requirement: about-blank transition immunity
URL guard logic MUST ignore transient `about:` frame navigations to prevent self-triggering restore loops.

#### Scenario: about:blank during normal navigation
- **WHEN** Chromium emits `framenavigated` with `about:blank` as an intermediate step
- **THEN** guard logic MUST return without initiating safe-url restoration

### Requirement: Overlay continuity in headful desktop platforms
On macOS and Windows headful custom flow, overlay controls MUST remain available through transient disallowed URLs.

#### Scenario: Transient disallowed URL on macOS/Windows
- **WHEN** current URL temporarily fails overlay-allowed checks but guard restoration is expected
- **THEN** overlay removal MUST be skipped and overlay MUST be re-injected or preserved for user continuity

#### Scenario: Linux/Docker headless overlay removal
- **WHEN** `isOverlayAllowed` returns false on Linux/Docker headless mode
- **THEN** overlay removal behavior is unchanged and overlay MAY be removed

### Requirement: Defensive closed-page handling
Custom-flow guard event handlers MUST tolerate unexpectedly closed pages and contexts.

#### Scenario: Page closes during guard callback
- **WHEN** a guard callback runs after page/context closure
- **THEN** the callback MUST fail safely without unhandled exceptions or infinite recovery attempts

### Requirement: Navigation wait strategy for domcontentloaded
The preNavigationHooks MUST set `waitUntil: 'domcontentloaded'` via in-place mutation of gotoOptions, not reassignment.

#### Scenario: gotoOptions mutation propagates to Crawlee
- **WHEN** preNavigationHooks sets navigation wait strategy
- **THEN** properties MUST be set by mutating the existing `gotoOptions` object and MUST NOT reassign the local parameter

#### Scenario: Sites with persistent network activity do not hang
- **WHEN** a site uses WebSockets, analytics polling, or lazy-load beacons
- **THEN** navigation MUST complete at `domcontentloaded` without waiting for network to idle