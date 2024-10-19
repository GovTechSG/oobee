import { Spec } from 'axe-core';

// Custom Axe Functions for axe.config
export const customAxeConfig: Spec = {
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
      id: 'oobee-accessible-label',
      metadata: {
        impact: 'serious',
        messages: {
          pass: 'The clickable element has an accessible label.',
          fail: "The clickable element does not have an accessible label.",
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
      id: 'oobee-accessible-label',
      selector: '[data-flagged="true"]',
      enabled: true,
      any: ['oobee-accessible-label'],
      tags: ['wcag2a', 'wcag111'],
      metadata: {
        description: 'Ensures clickable elements have an accessible label.',
        help: 'Clickable elements must have accessible labels.',
        helpUrl: 'https://www.example.com/blog/clickable-accessible-label',
      },
    },
  ],
};

export default customAxeConfig;
