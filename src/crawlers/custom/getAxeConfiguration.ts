import { ImpactValue } from "axe-core";
import { evaluateAltText } from "./evaluateAltText.js";

export function getAxeConfiguration({
  enableWcagAaa = false,
  gradingReadabilityFlag = '',
  disableA11yAssist = false,
}: {
  enableWcagAaa?: boolean;
  gradingReadabilityFlag?: string;
  disableA11yAssist?: boolean;
}) {
  function getReadabilityInterpretation(score: string): string {
    const num = parseFloat(score);
    if (Number.isNaN(num)) return '';
    if (num > 30) return 'It is targeted for junior college (JC) level comprehension and above.';
    return 'It is targeted for university graduate level comprehension and above.';
  }
  return {
    branding: {
      application: 'a11yassist',
    },
    checks: [
      {
        id: 'a11yassist-confusing-alt-text',
        metadata: {
          impact: 'serious' as ImpactValue,
          messages: {
            pass: 'The image alt text is probably useful.',
            fail: "The image alt text set as 'img', 'image', 'picture', 'photo', or 'graphic' is confusing or not useful.",
          },
        },
        evaluate: evaluateAltText,
      },
      {
        id: 'a11yassist-accessible-label',
        metadata: {
          impact: 'serious' as ImpactValue,
          messages: {
            pass: 'The clickable element has an accessible label.',
            fail: 'The clickable element does not have an accessible label.',
          },
        },
        evaluate: (node: HTMLElement) => {
          return !node.dataset.flagged; // fail any element with a data-flagged attribute set to true
        },
      },
      ...((enableWcagAaa && gradingReadabilityFlag !== '')
        ? [
          {
            id: 'a11yassist-grading-text-contents',
            metadata: {
              impact: 'moderate' as ImpactValue,
              messages: {
                pass: 'The text content is easy to understand.',
                fail: `Text content is potentially difficult to read.\n  It scored ${gradingReadabilityFlag} out of 50 on the Flesch-Kincaid Readability Test.\n  ${getReadabilityInterpretation(gradingReadabilityFlag)}`,
                incomplete: `Text content is potentially difficult to read.\n  It scored ${gradingReadabilityFlag} out of 50 on the Flesch-Kincaid Readability Test.\n  ${getReadabilityInterpretation(gradingReadabilityFlag)}`,
              },
            },
            evaluate: (_node: HTMLElement) => false,
          },
        ]
        : []),
    ],
    rules: [
      { id: 'target-size', enabled: true },
      {
        id: 'a11yassist-confusing-alt-text',
        selector: 'img[alt]',
        enabled: true,
        any: ['a11yassist-confusing-alt-text'],
        tags: ['wcag2a', 'wcag111'],
        metadata: {
          description: 'Ensures image alt text is clear and useful.',
          help: 'Image alt text must not be vague or unhelpful.',
          helpUrl: 'https://www.deque.com/blog/great-alt-text-introduction/',
        },
      },
      {
        id: 'a11yassist-accessible-label',
        // selector: '*', // to be set with the checker function output xpaths converted to css selectors
        enabled: true,
        any: ['a11yassist-accessible-label'],
        tags: ['wcag2a', 'wcag211', 'wcag412'],
        metadata: {
          description: 'Ensures clickable elements have an accessible label.',
          help: 'Clickable elements must have accessible labels.',
          helpUrl: 'https://www.deque.com/blog/accessible-aria-buttons',
        },
      },
      ...((enableWcagAaa && gradingReadabilityFlag !== '')
        ? [{
            id: 'a11yassist-grading-text-contents',
            selector: 'html',
            enabled: true,
            any: ['a11yassist-grading-text-contents'],
            tags: ['wcag2aaa', 'wcag315'],
            metadata: {
              description:
                'Text content should be easy to understand for individuals with education levels up to university graduates. If the text content is difficult to understand, provide supplemental content or a version that is easy to understand.',
              help: 'Text content should be clear and plain to ensure that it is easily understood.',
              helpUrl: 'https://www.wcag.com/uncategorized/3-1-5-reading-level/',
            },
          }]
        : []),
    ]
      .filter(rule => (disableA11yAssist ? !rule.id.startsWith('a11yassist') : true))
      .concat(
        enableWcagAaa
          ? [
            {
              id: 'color-contrast-enhanced',
              enabled: true,
            },
            {
              id: 'identical-links-same-purpose',
              enabled: true,
            },
            {
              id: 'meta-refresh-no-exceptions',
              enabled: true,
            },
          ]
          : [],
      ),
  };
}

