# Accessibility Scan Reports Documentation

Various types of reports are provided to help you to identify, manage, and understand the scale of accessibility for each website.  

In order to generate JSON reports, you need to parse the switch `-g yes` in Oobee CLI.  For each of the JSON reports listed below, a compressed version with the file extension `json.gz.b64` is provided.  See below for steps on uncompressing the compressed JSON files.

## HTML, CSV and Summary Reports

### report.html
An interactive HTML report that allows the user to interact and understand the different accessibility issues.  Note that if the number of scan issues is large > 510 MB of JSON data, the individual accessibility issues will not be viewable in the report.  Please refer to the report.csv for the detailed accessibility issues.

### summary.pdf
A short printable summary of the types and occurrences of accessibility issues found. It contains metadata of how many WCAG (Level A and AA) were violated.

### report.csv
This is the report which contains each individual accessibility issue found, across mustFix, goodToFix, and needsReview categories.  It contains the same information as a regular report.html except the scan metadata (i.e. how the scan was set up to run).  For scan metadata, please refer to scanData.csv.

This file contains detailed accessibility scan results, including issue details, affected pages, and recommendations.

#### CSV Structure

| Column Name          | Description |
|----------------------|-------------|
| `customFlowLabel`   | Label indicating the custom flow used for the scan. |
| `deviceChosen`      | Type of device used during the scan (e.g., Desktop, Mobile). |
| `scanCompletedAt`   | Timestamp indicating when the scan was completed (ISO 8601 format). |
| `severity`          | Severity level of the issue (`mustFix`, `goodToFix`, `needsReview`, `error`). |
| `issueId`           | Unique identifier for the issue found. |
| `issueDescription`  | Description of the issue detected during the scan. |
| `wcagConformance`   | WCAG guidelines that the issue relates to, comma-separated. |
| `url`              | The URL of the affected page. |
| `pageTitle`        | The title of the affected page. |
| `context`         | HTML snippet or element associated with the issue. |
| `howToFix`         | Suggested fix or recommendation to resolve the issue. |
| `axeImpact`        | Impact severity as determined by Axe (e.g., `critical`, `serious`, `moderate`, `minor`). |
| `xpath`            | XPath selector for locating the issue within the page. |
| `learnMore`        | URL to additional documentation about the issue (masked for privacy). |

#### Example CSV

```csv
"customFlowLabel","deviceChosen","scanCompletedAt","severity","issueId","issueDescription","wcagConformance","url","pageTitle","context","howToFix","axeImpact","xpath","learnMore"
"Custom Flow","Desktop","2025-03-13T10:09:18.733Z","needsReview","aria-prohibited-attr","Elements must only use permitted ARIA attributes","wcag2a,wcag412","https://example.com/page1","Example Page 1","<a class=""nav-link"" aria-label=""Example Link"">Example<i class=""icon-chevron-down"" aria-hidden=""true""></i></a>","aria-label attribute is not well supported on an <a> with no valid role attribute.","serious","a[aria-label=""Example Link""]","https://dequeuniversity.com/rules/axe/4.10/aria-prohibited-attr"
"Custom Flow","Desktop","2025-03-13T10:09:18.733Z","error","error-pages-skipped","Page was skipped during the scan",,"https://example.com/file.pdf","Error",,,,,,
```

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
  "pagesNotAffected": [
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
    }
  ],
  "scannedPagesCount": <number>,
  "pagesNotScanned": [
    {
      "url": "<string>",
      "pageTitle": "<string>",
      "actualUrl": "about:blank"
    },
  ],
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
  "pagesNotAffected": [
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
  "scannedPagesCount": <number>,
  "pagesNotScanned": [
    {
      "url": "<string>",
      "pageTitle": "<string>",
      "actualUrl": "about:blank"
    },
  ],
  "pagesNotScannedCount": <number>
}
```

## Manage Compressed JSON in Base64 Encoding

To deflate the .json.gz.b64, use the following with `pako` library installed:
```js
 // Decompress the binary data using pako.inflate
  const decompressedBytes = pako.inflate(compressedBytes);

  // Decode the decompressed bytes into a UTF-8 string
  const jsonString = new TextDecoder().decode(decompressedBytes);

  // Parse and return the JSON object
  return JSON.parse(jsonString);
```
