export const setHeadlessMode = (browser: string, isHeadless: boolean): void => {
  if (isHeadless) {
    process.env.CRAWLEE_HEADLESS = '1';
  } else {
    process.env.CRAWLEE_HEADLESS = '0';
  }
};

export const setThresholdLimits = (setWarnLevel: string): void => {
  process.env.WARN_LEVEL = setWarnLevel;
};
