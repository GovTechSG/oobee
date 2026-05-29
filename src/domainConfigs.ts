export const SLOWDOWN_URLS_CONFIG: Record<string, { minConcurrency: number; maxConcurrency: number; delayMinMax: [number, number] }> = {
  'https://www.mci.gov.sg': { minConcurrency: 1, maxConcurrency: 5, delayMinMax: [0, 1000] },
  'https://www.mas.gov.sg/': { minConcurrency: 1, maxConcurrency: 5, delayMinMax: [0, 1000] },
  'https://www.mlaw.gov.sg': { minConcurrency: 1, maxConcurrency: 5, delayMinMax: [0, 1000] },
  'https://www.a-star.edu.sg/': { minConcurrency: 1, maxConcurrency: 5, delayMinMax: [1000, 2000] },
  'https://www.developer.tech.gov.sg/': { minConcurrency: 1, maxConcurrency: 5, delayMinMax: [1000, 2000] },
  'https://www.psd.gov.sg': { minConcurrency: 1, maxConcurrency: 5, delayMinMax: [0, 1000] },
  'https://www.enablingguide.sg': { minConcurrency: 1, maxConcurrency: 5, delayMinMax: [1000, 2000] },
};

export function getSlowdownConfig(startingUrl: string): { maxConcurrency: number; delayFn: ((url: string) => number) | undefined } {
  const config = SLOWDOWN_URLS_CONFIG[startingUrl];
  if (!config) return { maxConcurrency: 0, delayFn: undefined };
  const [min, max] = config.delayMinMax;
  return {
    maxConcurrency: config.maxConcurrency,
    delayFn: () => Math.random() * (max - min) + min,
  };
}
