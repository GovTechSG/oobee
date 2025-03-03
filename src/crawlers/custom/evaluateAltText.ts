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

