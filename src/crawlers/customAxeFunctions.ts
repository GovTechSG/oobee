import { ImpactValue } from 'axe-core';
export function evaluateAltText(node: Element) {
  const altText = node.getAttribute('alt');
  const confusingTexts = ['img', 'image', 'picture', 'photo', 'graphic'];

  if (altText) {
    const trimmedAltText = altText.trim().toLowerCase();
    if (confusingTexts.includes(trimmedAltText)) {
      return false;
    }
  }
  return true;
}

// for css id selectors starting with a digit, escape it with the unicode character e.g. #123 -> #\31 23
export function escapeCSSSelector(selector: string) {
  try {
    return selector.replace(/([#\.])(\d)/g, (_match, prefix, digit) => `${prefix}\\3${digit} `);
  } catch (e) {
    console.error(`error escaping css selector: ${selector}`, e);
    return selector;
  }
}

export function framesCheck(cssSelector: string): {
  doc: Document;
  remainingSelector: string;
} {
  let doc = document; // Start with the main document
  let remainingSelector = ''; // To store the last part of the selector
  let targetIframe = null;

  // Split the selector into parts at "> html"
  const diffParts = cssSelector.split(/\s*>\s*html\s*/);

  for (let i = 0; i < diffParts.length - 1; i++) {
    let iframeSelector = `${diffParts[i].trim()}`;

    // Add back '> html' to the current part
    if (i > 0) {
      iframeSelector = `html > ${iframeSelector}`;
    }

    let frameset = null;
    // Find the iframe using the current document context
    if (doc.querySelector('frameset')) {
      frameset = doc.querySelector('frameset');
    }

    if (frameset) {
      doc = frameset;
      iframeSelector = iframeSelector.split('body >')[1].trim();
    }
    targetIframe = doc.querySelector(iframeSelector);

    if (targetIframe && targetIframe.contentDocument) {
      // Update the document to the iframe's contentDocument
      doc = targetIframe.contentDocument;
    } else {
      console.warn(
        `Iframe not found or contentDocument inaccessible for selector: ${iframeSelector}`,
      );
      return { doc, remainingSelector: cssSelector }; // Return original selector if iframe not found
    }
  }

  // The last part is the remaining CSS selector
  remainingSelector = diffParts[diffParts.length - 1].trim();

  // Remove any leading '>' combinators from remainingSelector
  remainingSelector = `html${remainingSelector}`;

  return { doc, remainingSelector };
}

export function findElementByCssSelector(cssSelector: string): string | null {
  let doc = document;

  // Check if the selector includes 'frame' or 'iframe' and update doc and selector

  if (/\s*>\s*html\s*/.test(cssSelector)) {
    const inFrames = framesCheck(cssSelector);
    doc = inFrames.doc;
    cssSelector = inFrames.remainingSelector;
  }

  // Query the element in the document (including inside frames)
  let element = doc.querySelector(cssSelector);

  // Handle Shadow DOM if the element is not found
  if (!element) {
    const shadowRoots = [];
    const allElements = document.querySelectorAll('*');

    // Look for elements with shadow roots
    allElements.forEach(el => {
      if (el.shadowRoot) {
        shadowRoots.push(el.shadowRoot);
      }
    });

    // Search inside each shadow root for the element
    for (const shadowRoot of shadowRoots) {
      const shadowElement = shadowRoot.querySelector(cssSelector);
      if (shadowElement) {
        element = shadowElement; // Found the element inside shadow DOM
        break;
      }
    }
  }

  if (element) {
    return element.outerHTML;
  }

  console.warn(`Unable to find element for css selector: ${cssSelector}`);
  return null;
}

export function getAxeConfiguration({
  enableWcagAaa = false,
  gradingReadabilityFlag = '',
  disableOobee = false,
}: {
  enableWcagAaa?: boolean;
  gradingReadabilityFlag?: string;
  disableOobee?: boolean;
}) {
  return {
    branding: {
      application: 'oobee',
    },
    checks: [
      {
        id: 'oobee-confusing-alt-text',
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
        id: 'oobee-accessible-label',
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
      ...(enableWcagAaa
        ? [
            {
              id: 'oobee-grading-text-contents',
              metadata: {
                impact: 'moderate' as ImpactValue,
                messages: {
                  pass: 'The text content is easy to understand.',
                  fail: 'The text content is potentially difficult to undersatnd.',
                  incomplete: `The text content is potentially difficult to read, with a Flesch-Kincaid Reading Ease score of ${
                    gradingReadabilityFlag
                  }.\nThe target passing score is above 50, indicating content readable by university students and lower grade levels.\nA higher score reflects better readability.`,
                },
              },
              evaluate: (_node: HTMLElement) => {
                if (gradingReadabilityFlag === '') {
                  return true; // Pass if no readability issues
                }
                // Fail if readability issues are detected
              },
            },
          ]
        : []),
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
        // selector: '*', // to be set with the checker function output xpaths converted to css selectors
        enabled: true,
        any: ['oobee-accessible-label'],
        tags: ['wcag2a', 'wcag211', 'wcag412'],
        metadata: {
          description: 'Ensures clickable elements have an accessible label.',
          help: 'Clickable elements must have accessible labels.',
          helpUrl: 'https://www.deque.com/blog/accessible-aria-buttons',
        },
      },
      {
        id: 'oobee-grading-text-contents',
        selector: 'html',
        enabled: true,
        any: ['oobee-grading-text-contents'],
        tags: ['wcag2aaa', 'wcag315'],
        metadata: {
          description:
            'Text content should be easy to understand for individuals with education levels up to university graduates. If the text content is difficult to understand, provide supplemental content or a version that is easy to understand.',
          help: 'Text content should be clear and plain to ensure that it is easily understood.',
          helpUrl: 'https://www.wcag.com/uncategorized/3-1-5-reading-level/',
        },
      },
    ]
      .filter(rule => (disableOobee ? !rule.id.startsWith('oobee') : true))
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
