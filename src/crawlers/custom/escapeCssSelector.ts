// for css id selectors starting with a digit, escape it with the unicode character e.g. #123 -> #\31 23
export function escapeCssSelector(selector: string) {
  try {
    return selector.replace(/([#\.])(\d)/g, (_match, prefix, digit) => `${prefix}\\3${digit} `);
  } catch (e) {
    console.error(`error escaping css selector: ${selector}`, e);
    return selector;
  }
}

