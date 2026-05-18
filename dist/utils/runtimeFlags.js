export const setHeadlessMode = (browser, isHeadless) => {
    if (isHeadless) {
        process.env.CRAWLEE_HEADLESS = '1';
    }
    else {
        process.env.CRAWLEE_HEADLESS = '0';
    }
};
export const setThresholdLimits = (setWarnLevel) => {
    process.env.WARN_LEVEL = setWarnLevel;
};
