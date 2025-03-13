# Accessibility Scan Reports Documentation

## scanItemsSummary.json

This file contains a summary of accessibility issues found in a scan, categorized into different levels of severity.

### Sample JSON
```json
{
  "oobeeAppVersion": "<string>",
  "mustFix": { "totalItems": <number>, "totalRuleIssues": <number> },
  "goodToFix": { "totalItems": <number>, "totalRuleIssues": <number> },
  "needsReview": { "totalItems": <number>, "totalRuleIssues": <number> },
  "topTenPagesWithMostIssues": [
    {
      "url": "<string>",
      "pageTitle": "<string>",
      "totalIssues": <number>,
      "totalOccurrences": <number>
    }
  ],
  "wcagLinks": {},
  "wcagPassPercentage": {
    "passPercentageAA": "<string>",
    "totalWcagChecksAA": <number>,
    "totalWcagViolationsAA": <number>,
    "passPercentageAAandAAA": "<string>",
    "totalWcagChecksAAandAAA": <number>,
    "totalWcagViolationsAAandAAA": <number>
  },
  "totalPagesScanned": <number>,
  "totalPagesNotScanned": <number>,
  "topTenIssues": [
    {
      "category": "<string>",
      "ruleId": "<string>",
      "description": "<string>",
      "axeImpact": "<string>",
      "conformance": ["<string>", "<string>"],
      "totalItems": <number>
    }
  ]
}
```

| Variable | Description |
|----------|-------------|
| `oobeeAppVersion` | Version of the Oobee application used for the scan. |
| `mustFix` | Summary of must-fix issues including `totalItems` and `totalRuleIssues`. |
| `goodToFix` | Summary of good-to-fix issues including `totalItems` and `totalRuleIssues`. |
| `needsReview` | Summary of needs-review issues including `totalItems` and `totalRuleIssues`. |
| `topTenPagesWithMostIssues` | List of the top ten pages with the most accessibility issues. |
| `url` | URL of the affected page. |
| `pageTitle` | Title of the affected page. |
| `totalIssues` | Total number of accessibility issues on the page. |
| `totalOccurrences` | Number of times these issues occurred. |
| `wcagLinks` | Mapping of WCAG guidelines to their documentation URLs. |
| `wcagPassPercentage` | Summary of WCAG compliance percentages. |
| `passPercentageAA` | Percentage of WCAG AA guidelines passed. |
| `totalWcagChecksAA` | Total WCAG AA checks performed. |
| `totalWcagViolationsAA` | Total WCAG AA violations found. |
| `passPercentageAAandAAA` | Percentage of WCAG AA and AAA guidelines passed. |
| `totalWcagChecksAAandAAA` | Total WCAG AA and AAA checks performed. |
| `totalWcagViolationsAAandAAA` | Total WCAG AA and AAA violations found. |
| `totalPagesScanned` | Total number of pages scanned. |
| `totalPagesNotScanned` | Total number of pages not scanned. |
| `topTenIssues` | List of the ten most common accessibility issues. |
| `category` | Category of the issue (`mustFix`, `goodToFix`, `needsReview`). |
| `ruleId` | Identifier of the accessibility rule violated. |
| `description` | Description of the accessibility issue. |
| `axeImpact` | Severity impact as determined by Axe. |
| `conformance` | List of WCAG guidelines the rule conforms to. |
| `totalItems` | Number of times this issue was detected. |



## scanIssuesSummary.json

This file contains a summary of accessibility issues found in a scan, categorized into different levels of severity.

### Sample JSON
```json
{
  "oobeeAppVersion": "<string>",
  "mustFix": [],
  "goodToFix": [
    {
      "rule": "<string>",
      "description": "<string>",
      "axeImpact": "<string>",
      "helpUrl": "<string>",
      "conformance": ["<string>", "<string>"],
      "totalItems": <number>,
      "pagesAffectedCount": <number>
    }
  ],
  "needsReview": [
  ],
  "passed": [
  ],
}
```

| Variable | Description |
|----------|-------------|
| `oobeeAppVersion` | Version of the Oobee application used for the scan. |
| `mustFix` | Array of must-fix issues. |
| `goodToFix` | Array of good-to-fix issues. |
| `needsReview` | Array of issues requiring human review. |
| `passed` | Array of rules that were checked and passed. |
| `rule` | Unique identifier of the accessibility rule being checked. |
| `description` | Description of the accessibility issue. |
| `axeImpact` | Severity impact as determined by Axe. |
| `helpUrl` | URL with more information on the accessibility rule. |
| `conformance` | List of WCAG guidelines the rule conforms to. |
| `totalItems` | Number of times this issue was detected. |
| `pagesAffectedCount` | Number of pages where this issue was found. |

## scanPagesSummary.json

This file contains a summary of pages affected by accessibility issues.

### Sample JSON
```json
{
  "oobeeAppVersion": "<string>",
  "pagesAffected": [
    {
      "pageTitle": "<string>",
      "url": "<string>",
      "totalOccurrencesFailedIncludingNeedsReview": <number>,
      "totalOccurrencesFailedExcludingNeedsReview": <number>,
      "totalOccurrencesMustFix": <number>,
      "totalOccurrencesGoodToFix": <number>,
      "totalOccurrencesNeedsReview": <number>,
      "totalOccurrencesPassed": <number>,
      "occurrencesExclusiveToNeedsReview": <boolean>,
      "typesOfIssuesCount": <number>,
      "typesOfIssuesExcludingNeedsReviewCount": <number>,
      "categoriesPresent": ["<string>", "<string>"],
      "conformance": ["<string>", "<string>", "<string>"]
    }
  ],
  "pagesNotAffected": [],
  "scannedPagesCount": <number>,
  "pagesNotScanned": [],
  "pagesNotScannedCount": <number>
}
```

| Variable | Description |
|----------|-------------|
| `oobeeAppVersion` | Version of the Oobee application used for the scan. |
| `pagesAffected` | Array of objects representing pages with accessibility issues. |
| `pageTitle` | Title of the affected page. |
| `url` | URL of the affected page. |
| `totalOccurrencesFailedIncludingNeedsReview` | Total number of failed checks, including needs-review issues. |
| `totalOccurrencesFailedExcludingNeedsReview` | Total number of failed checks, excluding needs-review issues. |
| `totalOccurrencesMustFix` | Number of must-fix occurrences of the rule. |
| `totalOccurrencesGoodToFix` | Number of good-to-fix occurrences of the rule. |
| `totalOccurrencesNeedsReview` | Number of occurrences requiring review. |
| `totalOccurrencesPassed` | Number of times the rule was checked and passed. |
| `occurrencesExclusiveToNeedsReview` | Boolean indicating whether the page has only needs-review issues. |
| `typesOfIssuesCount` | Number of unique issue types found on the page. |
| `typesOfIssuesExcludingNeedsReviewCount` | Number of unique issue types found on the page, excluding needs-review issues. |
| `categoriesPresent` | List of issue categories found on the page. |
| `conformance` | List of WCAG guidelines applicable to the issues found on the page. |
| `pagesNotAffected` | Array of pages that did not have any accessibility issues. |
| `scannedPagesCount` | Total number of pages scanned. |
| `pagesNotScanned` | Array of pages that were not scanned. |
| `pagesNotScannedCount` | Number of pages that were not scanned. |


## scanPagesDetail.json

This file contains a summary of accessibility issues found in a scan, categorized into different levels of severity.

### Sample JSON

```json
{
  "oobeeAppVersion": "<string>",
  "pagesAffected": [
    {
      "pageTitle": "<string>",
      "url": "<string>",
      "totalOccurrencesFailedIncludingNeedsReview": <number>,
      "totalOccurrencesFailedExcludingNeedsReview": <number>,
      "totalOccurrencesMustFix": <number>,
      "totalOccurrencesGoodToFix": <number>,
      "totalOccurrencesNeedsReview": <number>,
      "totalOccurrencesPassed": <number>,
      "occurrencesExclusiveToNeedsReview": <boolean>,
      "typesOfIssuesCount": <number>,
      "typesOfIssuesExcludingNeedsReviewCount": <number>,
      "categoriesPresent": ["<string>", "<string>"],
      "conformance": ["<string>", "<string>", "<string>"],
      "typesOfIssues": [
        {
          "ruleId": "<string>",
          "wagConformance": ["<string>", "<string>"],
          "occurrencesMustFix": <number>,
          "occurrencesGoodToFix": <number>,
          "occurrencesNeedsReview": <number>,
          "occurrencesPassed": <number>
        }
      ]
    }
  ],
  "pagesNotAffected": [],
  "scannedPagesCount": <number>,
  "pagesNotScanned": [],
  "pagesNotScannedCount": <number>
}
```
