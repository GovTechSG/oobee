// Issues with all warn level except none
// 0: critical, 1: serious, 2: moderate, 3: minor
export const allIssues = [
  {
    url: 'https://www.isomer.gov.sg/terms-of-use/',
    page: '/terms-of-use/',
    description: 'Buttons must have discernible text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.2/button-name?application=a11yassist',
    htmlElement:
      "<button class='bp-button'><i class='sgds-icon sgds-icon-mail is-size-4'></i>/button>",
    order: 3,
    wcagLinks: [['https://www.w3.org/WAI/WCAG21/Understanding/text-alternatives']],
    impact: 'critical',
    disabilities: ['disabilities'],
  },
  {
    url: 'https://www.isomer.gov.sg/terms-of-use/',
    page: '/terms-of-use/',
    description: 'Buttons must have discernible text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.2/button-name?application=a11yassist',
    htmlElement:
      "<button class='bp-button'><i class='sgds-icon sgds-icon-mail is-size-4'></i>/button>",
    order: 3,
    wcagLinks: [['https://www.w3.org/WAI/WCAG21/Understanding/text-alternatives']],
    impact: 'serious',
    disabilities: ['disabilities'],
  },
  {
    url: 'https://www.isomer.gov.sg/terms-of-use/',
    page: '/terms-of-use/',
    description: 'Buttons must have discernible text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.2/button-name?application=a11yassist',
    htmlElement:
      "<button class='bp-button'><i class='sgds-icon sgds-icon-mail is-size-4'></i>/button>",
    order: 3,
    wcagLinks: [['https://www.w3.org/WAI/WCAG21/Understanding/text-alternatives']],
    impact: 'moderate',
    disabilities: ['disabilities'],
  },
  {
    url: 'https://www.isomer.gov.sg/terms-of-use/',
    page: '/terms-of-use/',
    description: 'Buttons must have discernible text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.2/button-name?application=a11yassist',
    htmlElement:
      "<button class='bp-button'><i class='sgds-icon sgds-icon-mail is-size-4'></i>/button>",
    order: 3,
    wcagLinks: [['https://www.w3.org/WAI/WCAG21/Understanding/text-alternatives']],
    impact: 'minor',
    disabilities: ['disabilities'],
  },
];

// All Except Target Warn Level Issues
export const allExceptCritical = [allIssues[1], allIssues[2], allIssues[3]];
export const allExceptSerious = [allIssues[0], allIssues[2], allIssues[3]];
export const allExceptModerate = [allIssues[0], allIssues[1], allIssues[3]];
export const allExceptMinor = [allIssues[0], allIssues[1], allIssues[2]];

// Individual Target Warn Level Issues
export const criticalOnly = [allIssues[0]];
export const seriousOnly = [allIssues[1]];
export const moderateOnly = [allIssues[2]];
export const minorOnly = [allIssues[3]];
