# fix: prevent OOM and browser crash in report generation for large scans

## Summary

- Fix `summary.ejs` inlining the entire scan items payload (2 GB+ for 1000-page scans) via `JSON.stringify`, causing V8 OOM and killing the process
- Fix `report.html` embedded scanItems exceeding browser memory limits (746 MB uncompressed JSON for 1000-page scans)
- Fix write stream backpressure handling when embedding chunked base64 data
- `writeSummaryHTML` crash also blocked `report.html` generation since it runs first

## Problem 1: OOM in summary.html generation (server-side)

For large scans (e.g. 1000 pages, 2.5M+ passed occurrences), `summary.ejs` serialized the full `items` object — including every rule's `pagesAffected` array with all individual issue items — into an inline `<script>` tag. This produced a string exceeding V8's limits, crashing the process silently.

The result: neither `summary.html` nor `report.html` were generated, even though all JSON artifacts (`scanData.json`, `scanItems.json`, etc.) were written successfully.

## Problem 2: Browser cannot parse embedded scanItems (client-side)

Even with report generation fixed, the browser failed to load the All Issues view:
```
Failed to decode/unzip/parse: Unexpected end of JSON input
```

Root cause: `convertItemsToReferences` stripped per-page `items` arrays but still embedded the full `pagesAffected` array (url, pageTitle, actualUrl, metadata, etc. for every page × every rule). For 1000-page scans this produced **746 MB of uncompressed JSON** after base64-decode and gunzip — exceeding browser string/memory limits during `JSON.parse()`.

## Problem 3: Write stream backpressure (server-side)

The `writeHTML` function writes scan items as 2 MB base64 chunks via a `for await` loop over a read stream. `outputStream.write()` was not being checked for backpressure — when the write buffer filled up, subsequent writes could be silently dropped, producing truncated base64.

## Fix

### summary.ejs (OOM fix)
Strip the inline JSON to only what `summaryTable.ejs` actually needs:
- Rule-level metadata: `description`, `helpUrl`, `conformance`, `totalItems`
- `pagesAffected: { length: N }` (just the count object, not the full array)

This reduces the serialized payload from potentially gigabytes to a few kilobytes regardless of scan size.

### itemReferences.ts (browser payload fix)
`convertItemsToReferences` now strips each `pagesAffected` entry down to only `url`, `pageTitle`, and `itemsCount` — removing all per-item details (html snippets, screenshots, xpath, metadata, etc.) that constituted the bulk of the data. The All Issues list renders rule totals, and the "Group By Page" view in the rule modal still shows page URLs with occurrence counts.

This reduces the embedded payload from 746 MB (uncompressed) to ~11 MB for a 1000-page scan — well within browser memory limits.

### mergeAxeResults.ts (backpressure fix)
Await the `drain` event on the output stream when `write()` returns `false` before writing the next chunk. This ensures all base64 data is fully written to the report regardless of payload size.

## Files changed

| File | Change |
|------|--------|
| `src/static/ejs/summary.ejs` | Strip inline JSON to rule counts only |
| `src/mergeAxeResults/itemReferences.ts` | Strip `pagesAffected` to lightweight entries (url, pageTitle, itemsCount only) |
| `src/mergeAxeResults.ts` | Await drain on backpressure during chunked write |
| `src/static/ejs/partials/scripts/ruleModal/ruleOffcanvas.ejs` | Fall back to `pagesAffectedCount` |
| `src/static/ejs/partials/scripts/ruleModal/pageAccordionBuilder.ejs` | Fall back to `pagesAffectedCount` |

## Test plan

- [ ] Run a large scan (500+ pages) and verify both `summary.html` and `report.html` are generated
- [ ] Open `summary.html` in a browser and verify the summary table renders correctly (issue counts, page counts, help links)
- [ ] Open `report.html` and verify the All Issues list loads and displays rule counts correctly
- [ ] Verify the rule modal shows correct "Pages affected" count
- [ ] Verify small scans still produce correct reports (no regression)
