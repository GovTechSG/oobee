import crawlConfig from './crawl-config.json' with { type: 'json' };

export const SLOWDOWN_URLS_CONFIG = crawlConfig.slowdownUrls as unknown as Record<string, { minConcurrency: number; maxConcurrency: number; delayMinMax: [number, number] }>;

export function getSlowdownConfig(startingUrl: string): { maxConcurrency: number; delayFn: ((url: string) => number) | undefined } {
  const config = SLOWDOWN_URLS_CONFIG[startingUrl];
  if (!config) return { maxConcurrency: 0, delayFn: undefined };
  const [min, max] = config.delayMinMax;
  return {
    maxConcurrency: config.maxConcurrency,
    delayFn: () => Math.random() * (max - min) + min,
  };
}
