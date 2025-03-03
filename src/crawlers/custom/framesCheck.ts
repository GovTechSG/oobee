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

