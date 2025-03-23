import { framesCheck } from "./framesCheck.js";

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
    const shadowRoots: ShadowRoot[] = [];
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

