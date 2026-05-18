import constants from '../constants/constants.js';
export const getWcagPassPercentage = (wcagViolations, showEnableWcagAaa) => {
    // These AAA rules should not be counted as WCAG Pass Percentage only contains A and AA
    const wcagAAALinks = [
        'WCAG 1.4.6',
        'WCAG 2.2.4',
        'WCAG 2.4.9',
        'WCAG 3.1.5',
        'WCAG 3.2.5',
        'WCAG 2.1.3',
    ];
    const wcagAAA = ['wcag146', 'wcag224', 'wcag249', 'wcag315', 'wcag325', 'wcag213'];
    const wcagLinksAAandAAA = constants.wcagLinks;
    const wcagViolationsAAandAAA = showEnableWcagAaa ? wcagViolations.length : null;
    const totalChecksAAandAAA = showEnableWcagAaa ? Object.keys(wcagLinksAAandAAA).length : null;
    const passedChecksAAandAAA = showEnableWcagAaa
        ? totalChecksAAandAAA - wcagViolationsAAandAAA
        : null;
    // eslint-disable-next-line no-nested-ternary
    const passPercentageAAandAAA = showEnableWcagAaa
        ? totalChecksAAandAAA === 0
            ? 0
            : (passedChecksAAandAAA / totalChecksAAandAAA) * 100
        : null;
    const wcagViolationsAA = wcagViolations.filter(violation => !wcagAAA.includes(violation)).length;
    const totalChecksAA = Object.keys(wcagLinksAAandAAA).filter(key => !wcagAAALinks.includes(key)).length;
    const passedChecksAA = totalChecksAA - wcagViolationsAA;
    const passPercentageAA = totalChecksAA === 0 ? 0 : (passedChecksAA / totalChecksAA) * 100;
    return {
        passPercentageAA: passPercentageAA.toFixed(2), // toFixed returns a string, which is correct here
        totalWcagChecksAA: totalChecksAA,
        totalWcagViolationsAA: wcagViolationsAA,
        passPercentageAAandAAA: passPercentageAAandAAA ? passPercentageAAandAAA.toFixed(2) : null, // toFixed returns a string, which is correct here
        totalWcagChecksAAandAAA: totalChecksAAandAAA,
        totalWcagViolationsAAandAAA: wcagViolationsAAandAAA,
    };
};
export const getProgressPercentage = (scanPagesDetail, showEnableWcagAaa) => {
    const pages = scanPagesDetail.pagesAffected || [];
    const progressPercentagesAA = pages.map((page) => {
        const violations = page.conformance;
        return getWcagPassPercentage(violations, showEnableWcagAaa).passPercentageAA;
    });
    const progressPercentagesAAandAAA = pages.map((page) => {
        const violations = page.conformance;
        return getWcagPassPercentage(violations, showEnableWcagAaa).passPercentageAAandAAA;
    });
    const totalAA = progressPercentagesAA.reduce((sum, p) => sum + parseFloat(p), 0);
    const avgAA = progressPercentagesAA.length ? totalAA / progressPercentagesAA.length : 0;
    const totalAAandAAA = progressPercentagesAAandAAA.reduce((sum, p) => sum + parseFloat(p), 0);
    const avgAAandAAA = progressPercentagesAAandAAA.length
        ? totalAAandAAA / progressPercentagesAAandAAA.length
        : 0;
    return {
        averageProgressPercentageAA: avgAA.toFixed(2),
        averageProgressPercentageAAandAAA: avgAAandAAA.toFixed(2),
    };
};
