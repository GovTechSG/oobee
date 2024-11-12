// Custom Axe Functions for axe.config
const customAxeConfig = {
  branding: {
    application: 'oobee',
  },
  checks: [
    {
      id: 'oobee-confusing-alt-text',
      metadata: {
        impact: 'serious',
        messages: {
          pass: 'The image alt text is probably useful.',
          fail: "The image alt text set as 'img', 'image', 'picture', 'photo', or 'graphic' is confusing or not useful.",
        },
      },
    },
    {
      id: 'oobee-grading-text-contents',
      metadata: {
        impact: 'moderate',
        messages: {
          pass: 'The text contents is readable text.',
          fail: "The text contents is potentially unreadable text.",
        },
      },
    },
  ],
  rules: [
    { id: 'target-size', enabled: true },
    {
      id: 'oobee-confusing-alt-text',
      selector: 'img[alt]',
      enabled: true,
      any: ['oobee-confusing-alt-text'],
      tags: ['wcag2a', 'wcag111'],
      metadata: {
        description: 'Ensures image alt text is clear and useful.',
        help: 'Image alt text must not be vague or unhelpful.',
        helpUrl: 'https://www.deque.com/blog/great-alt-text-introduction/',
      },
    },
    {
      id: 'oobee-grading-text-contents',
      selector: 'p',
      enabled: true,
      any: ['oobee-grading-text-contents'],
      tags: ['wcag111'],
      metadata: {
        description: 'Ensures text that uses short, common words and short sentences is easier to decode.',
        help: 'Content should be written as clearly and simply as possible.',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/reading-level',
      },
    },
  ],
};

export default customAxeConfig;
