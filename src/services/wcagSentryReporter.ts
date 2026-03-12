import * as Sentry from '@sentry/node';
import { sentryConfig, setSentryUser } from '../constants/constants.js';
import { categorizeWcagCriteria, getUserDataTxt, getWcagCriteriaMap } from '../utils.js';
import type { AllIssues } from '../mergeAxeResults/types.js';

// Format WCAG tag in requested format: wcag111a_Occurrences
const formatWcagTag = async (wcagId: string): Promise<string | null> => {
  // Get dynamic WCAG criteria map
  const wcagCriteriaMap = await getWcagCriteriaMap();

  if (wcagCriteriaMap[wcagId]) {
    const { level } = wcagCriteriaMap[wcagId];
    return `${wcagId}${level}_Occurrences`;
  }
  return null;
};

// Send WCAG criteria breakdown to Sentry
const sendWcagBreakdownToSentry = async (
  appVersion: string,
  wcagBreakdown: Map<string, number>,
  ruleIdJson: any,
  scanInfo: {
    entryUrl: string;
    scanType: string;
    browser: string;
    email?: string;
    name?: string;
  },
  allIssues?: AllIssues,
  pagesScannedCount: number = 0,
) => {
  try {
    // Initialize Sentry
    Sentry.init(sentryConfig);
    // Set user ID for Sentry tracking
    const userData = getUserDataTxt();
    if (userData && userData.userId) {
      setSentryUser(userData.userId);
    }

    // Prepare tags for the event
    const tags: Record<string, string> = {};
    const wcagCriteriaBreakdown: Record<string, any> = {};

    // Tag app version
    tags.version = appVersion;

    // Get dynamic WCAG criteria map once
    const wcagCriteriaMap = await getWcagCriteriaMap();

    // Categorize all WCAG criteria for reporting
    const wcagIds = Array.from(
      new Set([...Object.keys(wcagCriteriaMap), ...Array.from(wcagBreakdown.keys())]),
    );
    const categorizedWcag = await categorizeWcagCriteria(wcagIds);

    // First ensure all WCAG criteria are included in the tags with a value of 0
    // This ensures criteria with no violations are still reported
    for (const [wcagId] of Object.entries(wcagCriteriaMap)) {
      const formattedTag = await formatWcagTag(wcagId);
      if (formattedTag) {
        // Initialize with zero
        tags[formattedTag] = '0';

        // Store in breakdown object with category information
        wcagCriteriaBreakdown[formattedTag] = {
          count: 0,
          category: categorizedWcag[wcagId] || 'mustFix', // Default to mustFix if not found
        };
      }
    }

    // Now override with actual counts from the scan
    for (const [wcagId, count] of wcagBreakdown.entries()) {
      const formattedTag = await formatWcagTag(wcagId);
      if (formattedTag) {
        // Add as a tag with the count as value
        tags[formattedTag] = String(count);

        // Update count in breakdown object
        if (wcagCriteriaBreakdown[formattedTag]) {
          wcagCriteriaBreakdown[formattedTag].count = count;
        } else {
          // If somehow this wasn't in our initial map
          wcagCriteriaBreakdown[formattedTag] = {
            count,
            category: categorizedWcag[wcagId] || 'mustFix',
          };
        }
      }
    }

    // Calculate category counts based on actual issue counts from the report
    // rather than occurrence counts from wcagBreakdown
    const categoryCounts = {
      mustFix: 0,
      goodToFix: 0,
      needsReview: 0,
    };

    if (allIssues) {
      // Use the actual report data for the counts
      categoryCounts.mustFix = allIssues.items.mustFix.rules.length;
      categoryCounts.goodToFix = allIssues.items.goodToFix.rules.length;
      categoryCounts.needsReview = allIssues.items.needsReview.rules.length;
    } else {
      // Fallback to the old way if allIssues not provided
      Object.values(wcagCriteriaBreakdown).forEach(item => {
        if (item.count > 0 && categoryCounts[item.category] !== undefined) {
          categoryCounts[item.category] += 1; // Count rules, not occurrences
        }
      });
    }

    // Add category counts as tags
    tags['WCAG-MustFix-Count'] = String(categoryCounts.mustFix);
    tags['WCAG-GoodToFix-Count'] = String(categoryCounts.goodToFix);
    tags['WCAG-NeedsReview-Count'] = String(categoryCounts.needsReview);

    // Also add occurrence counts for reference
    if (allIssues) {
      tags['WCAG-MustFix-Occurrences'] = String(allIssues.items.mustFix.totalItems);
      tags['WCAG-GoodToFix-Occurrences'] = String(allIssues.items.goodToFix.totalItems);
      tags['WCAG-NeedsReview-Occurrences'] = String(allIssues.items.needsReview.totalItems);

      // Add number of pages scanned tag
      tags['Pages-Scanned-Count'] = String(allIssues.totalPagesScanned);
    } else if (pagesScannedCount > 0) {
      // Still add the pages scanned count even if we don't have allIssues
      tags['Pages-Scanned-Count'] = String(pagesScannedCount);
    }

    // Send the event to Sentry
    await Sentry.captureEvent({
      message: 'Accessibility Scan Completed',
      level: 'info',
      tags: {
        ...tags,
        event_type: 'accessibility_scan',
        scanType: scanInfo.scanType,
        browser: scanInfo.browser,
        entryUrl: scanInfo.entryUrl,
      },
      user: {
        ...(scanInfo.email && scanInfo.name
          ? {
              email: scanInfo.email,
              username: scanInfo.name,
            }
          : {}),
        ...(userData && userData.userId ? { id: userData.userId } : {}),
      },
      extra: {
        additionalScanMetadata: ruleIdJson != null ? JSON.stringify(ruleIdJson) : '{}',
        wcagBreakdown: wcagCriteriaBreakdown,
        reportCounts: allIssues
          ? {
              mustFix: {
                issues: allIssues.items.mustFix.rules?.length ?? 0,
                occurrences: allIssues.items.mustFix.totalItems ?? 0,
              },
              goodToFix: {
                issues: allIssues.items.goodToFix.rules?.length ?? 0,
                occurrences: allIssues.items.goodToFix.totalItems ?? 0,
              },
              needsReview: {
                issues: allIssues.items.needsReview.rules?.length ?? 0,
                occurrences: allIssues.items.needsReview.totalItems ?? 0,
              },
            }
          : undefined,
      },
    });

    // Wait for events to be sent
    await Sentry.flush(2000);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error sending WCAG breakdown to Sentry:', error);
  }
};

export default sendWcagBreakdownToSentry;
