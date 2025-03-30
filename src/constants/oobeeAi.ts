// Purple AI rules to process axe outputted HTML into basicFormHTML snippets
// for sending to backend services to query GPT
export const oobeeAiRules = [
  'aria-allowed-attr',
  'aria-hidden-focus',
  'aria-input-field-name',
  'aria-required-attr',
  'aria-required-children',
  'aria-required-parent',
  'aria-roles',
  'aria-toggle-field-name',
  'aria-valid-attr',
  'aria-allowed-role',
  'form-field-multiple-labels',
  'label',
  'scrollable-region-focusable',
  'select-name',
  'landmark-unique',
  'meta-viewport-large',
  'presentation-role-conflict',
  'aria-treeitem-name',
  'server-side-image-map',
  'svg-img-alt',
  'autocomplete-valid',
];

export const oobeeAiHtmlETL = (htmlSnippet: string) => {
  // Whitelisted attributes (to not drop)
  // i.e. any other attribute will be dropped
  const whitelistedAttributes = [
    `type`,
    `tabindex`,
    `lang`,
    `scope`,
    `alt`,
    `role`,
    `charset`,
    `for`,
    `content`,
    `name`,
    `onclick`,
    `aria*`,
    `src`,
    `value`,
    `href`,
    `title`,
    `style`,
  ];

  // Attributes to mute
  const mutedAttributeValues = [
    `name`,
    `data`,
    `src`,
    `value`,
    `href`,
    `title`,
    `aria-describedby`,
    `aria-label`,
    `aria-labelledby`,
  ];

  const sortAlphaAttributes = (html: string) => {
    let entireHtml = '';
    const htmlOpeningTagRegex = /<[^>]+/g;
    const htmlTagmatches = html.match(htmlOpeningTagRegex);

    let sortedHtmlTag: string = '';

    htmlTagmatches.forEach(htmlTag => {
      const closingTag = htmlTag.trim().slice(-1) === '/' ? '/>' : '>';

      const htmlElementRegex = /<[^> ]+/;
      const htmlElement = htmlTag.match(htmlElementRegex);

      const htmlAttributeRegex = /[a-z-]+="[^"]*"/g;
      const allAttributes = htmlTag.match(htmlAttributeRegex);

      if (allAttributes) {
        sortedHtmlTag = `${htmlElement} `;
        allAttributes.sort((a, b) => {
          const attributeA = a.toLowerCase();
          const attributeB = b.toLowerCase();

          if (attributeA < attributeB) {
            return -1;
          }

          if (attributeA > attributeB) {
            return 1;
          }

          return 0;
        });

        allAttributes.forEach((htmlAttribute, index) => {
          sortedHtmlTag += htmlAttribute;
          if (index !== allAttributes.length - 1) {
            sortedHtmlTag += ' ';
          }
        });

        sortedHtmlTag += closingTag;
      } else {
        sortedHtmlTag = htmlElement + closingTag;
      }

      entireHtml += sortedHtmlTag;
    });
    return entireHtml;
  };

  // For all attributes within mutedAttributeValues array
  // replace their values with "something" while maintaining the attribute
  const muteAttributeValues = (html: string) => {
    const regex = /(\s+)([\w-]+)(\s*=\s*")([^"]*)(")/g;

    // p1 is the whitespace before the attribute
    // p2 is the attribute name
    // p3 is the attribute value before the replacement
    // p4 is the attribute value (replaced with "...")
    // p5 is the closing quote of the attribute value
    return html.replace(regex, (match, p1, p2, p3, _p4, p5) => {
      if (mutedAttributeValues.includes(p2)) {
        return `${p1}${p2}${p3}...${p5}`;
      }
      return match;
    });
  };

  // Drop all attributes from the HTML snippet except whitelisted
  const dropAllExceptWhitelisted = (html: string) => {
    const regex = new RegExp(
      `(\\s+)(?!${whitelistedAttributes.join(`|`)})([\\w-]+)(\\s*=\\s*"[^"]*")`,
      `g`,
    );
    return html.replace(regex, ``);
  };

  return sortAlphaAttributes(muteAttributeValues(dropAllExceptWhitelisted(htmlSnippet)));
};
