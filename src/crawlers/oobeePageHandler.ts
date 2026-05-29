import { runAxeScript } from './commonCrawlerFunc.js';
import type { PageHandler } from '@govtechsg/oobee-crawler';
import { RuleFlags } from '../constants/constants.js';

export function createOobeePageHandler({
  includeScreenshots,
  randomToken,
  ruleset = [],
}: {
  includeScreenshots: boolean;
  randomToken: string;
  ruleset?: RuleFlags[];
}): PageHandler {
  return async ({ page, request, dataset }) => {
    const results = await runAxeScript({ includeScreenshots, page, randomToken, ruleset });
    results.url = request.url;
    await dataset.pushData(results);
  };
}
