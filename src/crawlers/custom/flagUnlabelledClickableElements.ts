import { Page } from 'playwright';

export const flagUnlabelledClickableElements = async (page: Page) => {
  // Just paste the entire script into the body of the page.evaluate callback below
  // There's some code that is not needed when running this on backend but
  // we avoid changing the script for now to make it easy to update
  return await page.evaluate(() => {
    const allowNonClickableFlagging = true; // Change this to true to flag non-clickable images
    const landmarkElements = [
      'header',
      'footer',
      'nav',
      'main',
      'article',
      'section',
      'aside',
      'form',
    ];
    const loggingEnabled = false; // Set to true to enable console warnings

    let previousFlaggedXPathsByDocument = {}; // Object to hold previous flagged XPaths
    const previousAllFlaggedElementsXPaths = []; // Array to store all flagged XPaths

    function getXPath(element: Node) {
      if (!element) return null;
      if (element instanceof HTMLElement && element.id) {
        return `//*[@id="${element.id}"]`;
      }
      if (element === element.ownerDocument.body) {
        return '/html/body';
      }
      if (!element.parentNode || element.parentNode.nodeType !== 1) {
        return '';
      }

      const siblings: Node[] = Array.from(element.parentNode.childNodes).filter(
        node => node.nodeName === element.nodeName,
      );
      const ix = siblings.indexOf(element) + 1;
      const siblingIndex = siblings.length > 1 ? `[${ix}]` : '';
      return `${getXPath(element.parentNode)}/${element.nodeName.toLowerCase()}${siblingIndex}`;
    }

    function customConsoleWarn(message: string, data?: any) {
      if (loggingEnabled) {
        if (data) {
          console.warn(message, data);
        } else {
          console.warn(message);
        }
      }
    }

    function hasPointerCursor(element: Element) {
      const computedStyle = element.ownerDocument.defaultView.getComputedStyle(element);
      const hasPointerStyle = computedStyle.cursor === 'pointer';
      const hasOnClick = element.hasAttribute('onclick');
      const hasEventListeners = Object.keys(element).some(prop => prop.startsWith('on'));

      // Check if the element is inherently interactive
      const isClickableRole = ['button', 'link', 'menuitem'].includes(element.getAttribute('role'));
      const isNativeClickableElement =
        ['a', 'button', 'input'].includes(element.nodeName.toLowerCase()) &&
        (element.nodeName.toLowerCase() !== 'a' || element.hasAttribute('href'));
      const hasTabIndex =
        element.hasAttribute('tabindex') && element.getAttribute('tabindex') !== '-1';

      return (
        hasPointerStyle ||
        hasOnClick ||
        hasEventListeners ||
        isClickableRole ||
        isNativeClickableElement ||
        hasTabIndex
      );
    }

    function isAccessibleText(value: string) {
      if (!value || value.trim().length === 0) {
        return false;
      }

      const trimmedValue = value.trim();

      // Check if the text contains any private use characters
      const privateUseRegex = /\p{Private_Use}/u;
      if (privateUseRegex.test(trimmedValue)) {
        return false;
      }

      // Check if the text contains at least one letter or number
      const accessibleTextRegex = /[\p{L}\p{N}]/u;
      if (accessibleTextRegex.test(trimmedValue)) {
        return true;
      }

      // If it doesn't contain letters or numbers, consider it not accessible
      return false;
    }

    function getElementById(element: Element, id: string) {
      return element.ownerDocument.getElementById(id);
    }

    function getAriaLabelledByText(element: Element) {
      const labelledById = element.getAttribute('aria-labelledby');
      if (labelledById) {
        const labelledByElement = getElementById(element, labelledById);
        if (labelledByElement) {
          const ariaLabel = labelledByElement.getAttribute('aria-label');
          return ariaLabel ? ariaLabel.trim() : labelledByElement.textContent.trim();
        }
      }
      return '';
    }

    function hasAccessibleLabel(element: Element) {
      const ariaLabel = element.getAttribute('aria-label');
      const ariaLabelledByText = getAriaLabelledByText(element);
      const altText = element.getAttribute('alt');
      const title = element.getAttribute('title');

      return (
        isAccessibleText(ariaLabel) ||
        isAccessibleText(ariaLabelledByText) ||
        isAccessibleText(altText) ||
        isAccessibleText(title)
      );
    }

    function hasSummaryOrDetailsLabel(element: Element) {
      const summary = element.closest('summary, details');
      return summary && hasAccessibleLabel(summary);
    }

    function hasSiblingWithAccessibleLabel(element: Element) {
      // Check all siblings (previous and next)
      let sibling = element.previousElementSibling;
      while (sibling) {
        if (hasAccessibleLabel(sibling)) {
          return true;
        }
        sibling = sibling.previousElementSibling;
      }

      sibling = element.nextElementSibling;
      while (sibling) {
        if (hasAccessibleLabel(sibling)) {
          return true;
        }
        sibling = sibling.nextElementSibling;
      }

      return false;
    }

    function hasSiblingOrParentAccessibleLabel(element: Element) {
      // Check previous and next siblings
      const previousSibling = element.previousElementSibling;
      const nextSibling = element.nextElementSibling;
      if (
        (previousSibling && hasAccessibleLabel(previousSibling)) ||
        (nextSibling && hasAccessibleLabel(nextSibling))
      ) {
        return true;
      }

      // Check the parent element
      const parent = element.parentElement;
      if (parent && hasAccessibleLabel(parent)) {
        return true;
      }

      return false;
    }

    function hasChildWithAccessibleText(element: Element) {
      // Check element children
      const hasAccessibleChildElement = Array.from(element.children).some(child => {
        if (child.nodeName.toLowerCase() === 'style' || child.nodeName.toLowerCase() === 'script') {
          return false;
        }
        // Skip children that are aria-hidden
        if (child.getAttribute('aria-hidden') === 'true') {
          return false;
        }
        return (
          isAccessibleText(child.textContent) || hasAccessibleLabel(child) || hasCSSContent(child)
        );
      });

      // Check direct text nodes
      const hasDirectAccessibleText = Array.from(element.childNodes).some(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          return isAccessibleText(node.textContent);
        }
        return false;
      });

      return hasAccessibleChildElement || hasDirectAccessibleText;
    }

    function hasAllChildrenAccessible(element: Element) {
      // If the element is aria-hidden, consider it accessible
      if (element.getAttribute('aria-hidden') === 'true') {
        return true;
      }

      // Check if the element itself has an accessible label, text content, or CSS content
      if (
        hasAccessibleLabel(element) ||
        isAccessibleText(element.textContent) ||
        hasCSSContent(element)
      ) {
        return true;
      }

      // If the element has children, ensure at least one of them is accessible
      if (element.children.length > 0) {
        return Array.from(element.children).some(child => {
          // If child is aria-hidden, skip it in the accessibility check
          if (child.getAttribute('aria-hidden') === 'true') {
            return true;
          }
          // Recursively check if the child or any of its descendants are accessible
          return hasAllChildrenAccessible(child);
        });
      }

      // If the element and all its children have no accessible labels or text, it's not accessible
      return false;
    }

    const style = document.createElement('style');
    style.innerHTML = `
   .highlight-flagged {
        outline: 4px solid rgba(128, 0, 128, 1) !important; /* Thicker primary outline with purple in rgba format */
        box-shadow: 
            0 0 25px 15px rgba(255, 255, 255, 1), /* White glow for contrast */
            0 0 15px 10px rgba(144, 33, 166, 1) !important; /* Consistent purple glow in rgba format */
    }
`;
    document.head.appendChild(style);

    function injectStylesIntoFrame(frame: HTMLIFrameElement) {
      try {
        const frameDocument = frame.contentDocument || frame.contentWindow.document;
        if (frameDocument) {
          const frameStyle = frameDocument.createElement('style');
          frameStyle.innerHTML = `
                .highlight-flagged {
                        outline: 4px solid rgba(128, 0, 128, 1) !important; /* Thicker primary outline with purple in rgba format */
                        box-shadow: 
                            0 0 25px 15px rgba(255, 255, 255, 1), /* White glow for contrast */
                            0 0 15px 10px rgba(144, 33, 166, 1) !important; /* Consistent purple glow in rgba format */
                }
            `;
          frameDocument.head.appendChild(frameStyle);
        }
      } catch (error) {
        customConsoleWarn(`Cannot access frame document: ${error}`);
      }
    }

    function hasCSSContent(element: Element) {
      const beforeContent = window
        .getComputedStyle(element, '::before')
        .getPropertyValue('content');
      const afterContent = window.getComputedStyle(element, '::after').getPropertyValue('content');

      function isAccessibleContent(value: string) {
        if (!value || value === 'none' || value === 'normal') {
          return false;
        }
        // Remove quotes from the content value
        const unquotedValue = value.replace(/^['"]|['"]$/g, '').trim();

        // Use the isAccessibleText function
        return isAccessibleText(unquotedValue);
      }

      return isAccessibleContent(beforeContent) || isAccessibleContent(afterContent);
    }

    function isElementTooSmall(element: Element) {
      // Get the bounding rectangle of the element
      const rect = element.getBoundingClientRect();

      // Check if width or height is less than 1
      return rect.width < 1 || rect.height < 1;
    }

    function shouldFlagElement(element: HTMLElement, allowNonClickableFlagging: boolean) {
      // if (!element || !(element instanceof Element)) {
      //     customConsoleWarn("Element is null or not a valid Element.");
      //     return false;
      // }

      // if (element.nodeName.toLowerCase() === "a")
      // {
      // }

      if (isElementTooSmall(element)) {
        return false;
      }

      // Skip non-clickable elements if allowNonClickableFlagging is false
      if (allowNonClickableFlagging && !hasPointerCursor(element)) {
        customConsoleWarn(
          'Element is not clickable and allowNonClickableFlagging is false, skipping flagging.',
        );
        return false;
      }

      // Do not flag elements if any ancestor has aria-hidden="true"
      if (element.closest('[aria-hidden="true"]')) {
        customConsoleWarn("An ancestor element has aria-hidden='true', skipping flagging.");
        return false;
      }

      let parents = element.parentElement;

      // Causing false negative of svg
      if (parents) {
        // Check if the parent has an accessible label
        if (hasAccessibleLabel(parents) || hasChildWithAccessibleText(parents)) {
          customConsoleWarn(
            'Parent element has an accessible label, skipping flagging of this element.',
          );
          return false;
        }

        /* TODO: Ask if this condition is needed cause this is what is causing the hamburger to not */
        // Check if any sibling (that is not an interactable) has an accessible label
        // const siblings = Array.from(parents.children);
        // const hasAccessibleSibling = siblings.some(sibling =>
        //     sibling !== element && (hasAccessibleLabel(sibling) || hasChildWithAccessibleText(sibling))
        // );
        // if (hasAccessibleSibling) {
        //     customConsoleWarn("A sibling element has an accessible label, skipping flagging.");
        //     return false;
        // }
      }

      while (parents) {
        // Skip flagging if the parent or the element itself has an accessible label
        if (hasAccessibleLabel(parents) || hasAccessibleLabel(element)) {
          customConsoleWarn('Parent or element has an accessible label, skipping flagging.');
          return false;
        }

        // Skip flagging if the parent is a button-like element with aria-expanded
        if (
          parents.getAttribute('role') === 'button' &&
          (parents.hasAttribute('aria-expanded') || parents.hasAttribute('aria-controls'))
        ) {
          customConsoleWarn(
            'Parent element is an interactive button with aria-expanded or aria-controls, skipping flagging.',
          );
          return false;
        }

        // Skip flagging if an ancestor has an accessible label or an interactive role (e.g., button, link)
        if (
          ['div', 'section', 'article', 'nav'].includes(parents.nodeName.toLowerCase()) &&
          hasAccessibleLabel(parents)
        ) {
          customConsoleWarn(
            'Ancestor element with contextual role has an accessible label, skipping flagging.',
          );
          return false;
        }

        parents = parents.parentElement;
      }

      // Skip elements with role="menuitem" if an accessible sibling, parent, or child is present
      if (element.getAttribute('role') === 'menuitem') {
        if (
          hasSiblingWithAccessibleLabel(element) ||
          hasChildWithAccessibleText(element) ||
          hasAccessibleLabel(element.parentElement)
        ) {
          customConsoleWarn(
            'Menuitem element or its sibling/parent has an accessible label, skipping flagging.',
          );
          return false;
        }
      }

      // Skip flagging child elements if the parent element has role="menuitem" and is accessible
      const parentMenuItem = element.closest('[role="menuitem"]');
      if (
        parentMenuItem &&
        (hasAccessibleLabel(parentMenuItem) || hasChildWithAccessibleText(parentMenuItem))
      ) {
        customConsoleWarn(
          'Parent menuitem element has an accessible label or child with accessible text, skipping flagging of its children.',
        );
        return false;
      }

      // Add the new condition for empty div or span elements without any accessible text or children with accessible labels
      if (
        (element.nodeName.toLowerCase() === 'span' || element.nodeName.toLowerCase() === 'div') &&
        element.children.length === 0 &&
        element.textContent.trim().length === 0
      ) {
        const parent = element.parentElement;
        if (parent) {
          const hasAccessibleChild = Array.from(parent.children).some(
            child => child !== element && hasAccessibleLabel(child),
          );

          if (hasAccessibleChild) {
            customConsoleWarn(
              'Parent element has an accessible child, skipping flagging of empty span or div.',
            );
            return false;
          }
        }
      }

      // Do not flag elements with aria-hidden="true"
      if (element.getAttribute('aria-hidden') === 'true') {
        customConsoleWarn('Element is aria-hidden, skipping flagging.');
        return false;
      }

      // Do not flag elements with role="presentation"
      if (element.getAttribute('role') === 'presentation') {
        customConsoleWarn("Element has role='presentation', skipping flagging.");
        return false;
      }

      if (element.dataset.flagged === 'true') {
        customConsoleWarn('Element is already flagged.');
        return false;
      }

      // If an ancestor element is flagged, do not flag this element
      if (element.closest('[data-flagged="true"]')) {
        customConsoleWarn('An ancestor element is already flagged.');
        return false;
      }

      // Skip elements that are not visible (e.g., display:none)
      const computedStyle = element.ownerDocument.defaultView.getComputedStyle(element);
      if (
        computedStyle.display === 'none' ||
        computedStyle.visibility === 'hidden' ||
        element.offsetParent === null
      ) {
        customConsoleWarn('Element is not visible, skipping flagging.');
        return false;
      }

      // Skip empty <div> or <span> elements without any accessible text or children with accessible labels, unless they have a pointer cursor
      if (
        (element.nodeName.toLowerCase() === 'div' || element.nodeName.toLowerCase() === 'span') &&
        element.children.length === 0 &&
        element.textContent.trim().length === 0
      ) {
        if (!hasPointerCursor(element)) {
          customConsoleWarn(
            'Empty div or span without accessible text and without pointer cursor, skipping flagging.',
          );
          return false;
        }

        // **New background-image check**
        const backgroundImage = window
          .getComputedStyle(element)
          .getPropertyValue('background-image');
        if (backgroundImage && backgroundImage !== 'none') {
          customConsoleWarn('Element has a background image.');

          // Check if the element has accessible labels or text content
          if (
            !hasAccessibleLabel(element) &&
            !hasChildWithAccessibleText(element) &&
            !isAccessibleText(element.textContent)
          ) {
            customConsoleWarn(
              'Flagging element with background image but without accessible label or text.',
            );
            return true; // Flag the element
          }
          customConsoleWarn(
            'Element with background image has accessible label or text, skipping flagging.',
          );
          return false; // Do not flag
        }

        // **Proceed with ancestor traversal if no background image is found**
        // Traverse ancestors to check for interactive elements with accessible labels
        let ancestor = element.parentElement;
        let depth = 0;
        const maxDepth = 4; // Limit the depth to prevent skipping elements incorrectly
        while (ancestor && depth < maxDepth) {
          // Determine if ancestor is interactive
          const isAncestorInteractive =
            hasPointerCursor(ancestor) ||
            ancestor.hasAttribute('onclick') ||
            ancestor.hasAttribute('role') ||
            (ancestor.hasAttribute('tabindex') && ancestor.getAttribute('tabindex') !== '-1') ||
            ancestor.hasAttribute('jsaction') ||
            ancestor.hasAttribute('jscontroller');

          if (isAncestorInteractive) {
            // Check if ancestor has accessible label or text content
            if (
              hasAccessibleLabel(ancestor) ||
              isAccessibleText(ancestor.textContent) ||
              hasChildWithAccessibleText(ancestor)
            ) {
              customConsoleWarn(
                'Ancestor interactive element has accessible label or text content, skipping flagging.',
              );
              return false;
            }
            // Ancestor is interactive but lacks accessible labeling
            customConsoleWarn(
              'Ancestor interactive element lacks accessible label, continue flagging.',
            );
            // Do not skip flagging
          }
          ancestor = ancestor.parentElement;
          depth++;
        }

        // If no interactive ancestor with accessible label is found, flag the element
        customConsoleWarn(
          'Flagging clickable div or span with pointer cursor and no accessible text.',
        );
        return true;
      }

      // Skip elements with role="menuitem" and ensure accessibility label for any nested elements
      if (element.getAttribute('role') === 'menuitem') {
        if (hasChildWithAccessibleText(element)) {
          customConsoleWarn('Menuitem element has child with accessible text, skipping flagging.');
          return false;
        }
      }

      // Check if the parent element has an accessible label
      const parent = element.closest('[aria-label], [role="button"], [role="link"], a, button');

      if (parent && (hasAccessibleLabel(parent) || hasChildWithAccessibleText(parent))) {
        customConsoleWarn(
          'Parent element has an accessible label or accessible child, skipping flagging.',
        );
        return false;
      }

      // Skip flagging if any child has an accessible label (e.g., <img alt="...">
      if (hasAllChildrenAccessible(element)) {
        customConsoleWarn('Element has child nodes with accessible text.');
        return false;
      }

      // Check if the <a> element has all children accessible
      if (element.nodeName.toLowerCase() === 'a' && hasAllChildrenAccessible(element)) {
        customConsoleWarn('Hyperlink has all children with accessible labels, skipping flagging.');
        return false;
      }

      if (element.hasAttribute('tabindex') && element.getAttribute('tabindex') === '-1') {
        customConsoleWarn("Element has tabindex='-1'.");
        return false;
      }

      const childWithTabindexNegativeOne = Array.from(element.children).some(
        child => child.hasAttribute('tabindex') && child.getAttribute('tabindex') === '-1',
      );
      if (childWithTabindexNegativeOne) {
        customConsoleWarn("Element has a child with tabindex='-1'.");
        return false;
      }

      if (landmarkElements.includes(element.nodeName.toLowerCase())) {
        customConsoleWarn('Element is a landmark element.');
        return false;
      }

      // Prevent flagging <svg> or <icon> if a sibling or parent has an accessible label or if it is part of a button-like element
      if (
        (element.nodeName.toLowerCase() === 'svg' || element.nodeName.toLowerCase() === 'icon') &&
        (element.getAttribute('focusable') === 'false' ||
          hasSiblingOrParentAccessibleLabel(element) ||
          element.closest('[role="button"]') ||
          element.closest('button'))
      ) {
        customConsoleWarn(
          'Sibling or parent element has an accessible label or svg is part of a button, skipping flagging of svg or icon.',
        );
        return false;
      }

      if (element.nodeName.toLowerCase() === 'svg') {
        const parentGroup = element.closest('g');
        if (parentGroup && parentGroup.querySelector('title')) {
          customConsoleWarn('Parent group element has a <title>, skipping flagging of svg.');
          return false;
        }
      }

      if (element.nodeName.toLowerCase() === 'button') {
        const hasAccessibleLabelForButton =
          hasAccessibleLabel(element) || isAccessibleText(element.textContent);
        if (hasAccessibleLabelForButton) {
          customConsoleWarn('Button has an accessible label, skipping flagging.');
          return false;
        }

        const hasSvgChildWithoutLabel = Array.from(element.children).some(
          child => child.nodeName.toLowerCase() === 'svg' && !hasAccessibleLabel(child),
        );
        if (hasSvgChildWithoutLabel) {
          customConsoleWarn('Flagging button with child SVG lacking accessible label.');
          return true;
        }
      }

      if (
        element instanceof HTMLInputElement &&
        // element.nodeName.toLowerCase() === 'input' &&
        element.type === 'image' &&
        !hasAccessibleLabel(element)
      ) {
        customConsoleWarn("Flagging <input type='image'> without accessible label.");
        return true;
      }

      if (element.nodeName.toLowerCase() === 'a') {
        const img = element.querySelector('img');

        // Log to verify visibility and pointer checks
        customConsoleWarn('Processing <a> element.');

        // Ensure this <a> does not have an accessible label
        const linkHasAccessibleLabel = hasAccessibleLabel(element);

        // Ensure the <img> inside <a> does not have an accessible label
        const imgHasAccessibleLabel = img ? hasAccessibleLabel(img) : false;

        // Log to verify if <img> has accessible label
        if (img) {
          customConsoleWarn(`Found <img> inside <a>. Accessible label: ${imgHasAccessibleLabel}`);
        } else {
          customConsoleWarn('No <img> found inside <a>.');
        }

        // Flag if both <a> and <img> inside lack accessible labels
        if (!linkHasAccessibleLabel && img && !imgHasAccessibleLabel) {
          customConsoleWarn('Flagging <a> with inaccessible <img>.');
          return true;
        }

        // Skip flagging if <a> has an accessible label or all children are accessible
        if (linkHasAccessibleLabel || hasAllChildrenAccessible(element)) {
          customConsoleWarn('Hyperlink has an accessible label, skipping flagging.');
          return false;
        }
      }

      // Modify this section for generic elements
      if (['span', 'div', 'icon', 'svg', 'button'].includes(element.nodeName.toLowerCase())) {
        if (element.nodeName.toLowerCase() === 'icon' || element.nodeName.toLowerCase() === 'svg') {
          // Check if the element has an accessible label or if it has a sibling, parent, or summary/related element that provides an accessible label
          if (
            !hasAccessibleLabel(element) &&
            !hasSiblingOrParentAccessibleLabel(element) &&
            !hasSummaryOrDetailsLabel(element) &&
            element.getAttribute('focusable') !== 'false'
          ) {
            customConsoleWarn('Flagging icon or svg without accessible label.');
            return true;
          }
          return false;
        }

        if (element.textContent.trim().length > 0) {
          customConsoleWarn('Element has valid text content.');
          return false;
        }

        if (
          element.hasAttribute('aria-label') &&
          element.getAttribute('aria-label').trim().length > 0
        ) {
          customConsoleWarn('Element has an aria-label attribute, skipping flagging.');
          return false;
        }
      }

      if (element.nodeName.toLowerCase() === 'div') {
        const flaggedChild = Array.from(element.children).some(
          (child: HTMLElement) => child.dataset.flagged === 'true',
        );
        if (flaggedChild) {
          customConsoleWarn('Div contains a flagged child, flagging only outermost element.');
          return false;
        }

        // Update this condition to include hasChildWithAccessibleText
        if (element.textContent.trim().length > 0 || hasChildWithAccessibleText(element)) {
          customConsoleWarn('Div has valid text content or child with accessible text.');
          return false;
        }

        const img = element.querySelector('img');
        if (img) {
          const altText = img.getAttribute('alt');
          const ariaLabel = img.getAttribute('aria-label');
          const ariaLabelledByText = getAriaLabelledByText(img);
          if (altText !== null || ariaLabel || ariaLabelledByText) {
            customConsoleWarn(
              'Div contains an accessible img or an img with an alt attribute (even if empty).',
            );
            return false;
          }
        }

        const svg = element.querySelector('svg');
        if (svg) {
          if (
            hasPointerCursor(element) &&
            !hasAccessibleLabel(svg) &&
            !hasSummaryOrDetailsLabel(svg) &&
            svg.getAttribute('focusable') !== 'false'
          ) {
            customConsoleWarn('Flagging clickable div with SVG without accessible label.');
            return true;
          }
        }

        if (
          hasPointerCursor(element) &&
          !hasAccessibleLabel(element) &&
          !isAccessibleText(element.textContent)
        ) {
          customConsoleWarn('Clickable div without accessible label or text content.');
          return true;
        }
      }

      if (
        element.nodeName.toLowerCase() === 'img' ||
        element.nodeName.toLowerCase() === 'picture'
      ) {
        const imgElement =
          element.nodeName.toLowerCase() === 'picture' ? element.querySelector('img') : element;
        const altText = imgElement.getAttribute('alt');
        const ariaLabel = imgElement.getAttribute('aria-label');
        const ariaLabelledByText = getAriaLabelledByText(imgElement);

        if (!allowNonClickableFlagging) {
          if (
            !imgElement.closest('a') &&
            !imgElement.closest('button') &&
            !hasPointerCursor(imgElement) &&
            !(altText !== null) &&
            !(ariaLabel && ariaLabel.trim().length > 0) &&
            !(ariaLabelledByText && ariaLabelledByText.length > 0)
          ) {
            customConsoleWarn('Non-clickable image ignored.');
            return false;
          }
        }

        if (
          !imgElement.closest('a') &&
          !imgElement.closest('button') &&
          !(altText !== null) &&
          !(ariaLabel && ariaLabel.trim().length > 0) &&
          !(ariaLabelledByText && ariaLabelledByText.length > 0)
        ) {
          customConsoleWarn('Flagging img or picture without accessible label.');
          return true;
        }
      }

      // Additional check to skip divs with empty children or child-child elements
      const areAllDescendantsEmpty = Array.from(element.querySelectorAll('*')).every(
        child => child.textContent.trim().length === 0 && !hasAccessibleLabel(child),
      );
      if (element.nodeName.toLowerCase() === 'div' && areAllDescendantsEmpty) {
        customConsoleWarn('Div with empty descendants, skipping flagging.');
        return false;
      }

      if (hasCSSContent(element)) {
        customConsoleWarn('Element has CSS ::before or ::after content, skipping flagging.');
        return false;
      }

      return false; // Default case: do not flag
    }

    function flagElements() {
      console.time('Accessibility Check Time');

      const currentFlaggedElementsByDocument: Record<string, HTMLElement[]> = {}; // Temporary object to hold current flagged elements

      /* 
        Collects all the elements and places then into an array
        Then places the array in the correct frame
    */
      // Process main document
      const currentFlaggedElements: HTMLElement[] = [];
      const allElements = Array.from(document.querySelectorAll<HTMLElement>('*'));
      let indexofAllElements: number = 0;

      while (indexofAllElements < allElements.length) {
        const element = allElements[indexofAllElements] as HTMLElement;
        // if it selects a frameset
        if (
          shouldFlagElement(element, allowNonClickableFlagging) ||
          element.dataset.flagged === 'true'
        ) {
          element.dataset.flagged = 'true'; // Mark element as flagged
          currentFlaggedElements.push(element);
        }

        // If the element has a shadowRoot, add its children
        if (element.shadowRoot) {
          allElements.push(
            ...(Array.from(element.shadowRoot.querySelectorAll('*')) as HTMLElement[]),
          );
        }
        indexofAllElements++;
      }
      currentFlaggedElementsByDocument[''] = currentFlaggedElements; // Key "" represents the main document

      // Process iframes
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((iframe, index) => {
        injectStylesIntoFrame(iframe);
        try {
          const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
          if (iframeDocument) {
            const iframeFlaggedElements: HTMLElement[] = [];
            const iframeElements = Array.from(iframeDocument.querySelectorAll<HTMLElement>('*'));
            let indexOfIframeElements: number = 0;
            while (indexOfIframeElements < iframeElements.length) {
              const element = iframeElements[indexOfIframeElements] as HTMLElement;
              if (
                shouldFlagElement(element, allowNonClickableFlagging) ||
                element.dataset.flagged === 'true'
              ) {
                element.dataset.flagged = 'true'; // Mark element as flagged
                iframeFlaggedElements.push(element);
              }
              // If the element has a shadowRoot, add its children
              if (element.shadowRoot) {
                iframeElements.push(
                  ...(Array.from(element.shadowRoot.querySelectorAll('*')) as HTMLElement[]),
                );
              }
              indexOfIframeElements++;
            }
            const iframeXPath = getXPath(iframe);
            currentFlaggedElementsByDocument[iframeXPath] = iframeFlaggedElements;
          }
        } catch (error) {
          console.warn(`Cannot access iframe document (${index}): ${error.message}`);
        }
      });

      // Process frames
      const frames = document.querySelectorAll('frame');
      frames.forEach((frame, index) => {
        // injectStylesIntoFrame(frame);
        try {
          const iframeDocument = frame.contentDocument || frame.contentWindow.document;
          if (iframeDocument) {
            const iframeFlaggedElements: HTMLElement[] = [];
            const iframeElements = Array.from(iframeDocument.querySelectorAll<HTMLElement>('*'));
            let indexOfIframeElements: number = 0;
            while (indexOfIframeElements < iframeElements.length) {
              const element = iframeElements[indexOfIframeElements] as HTMLElement;
              if (
                shouldFlagElement(element, allowNonClickableFlagging) ||
                element.dataset.flagged === 'true'
              ) {
                element.dataset.flagged = 'true'; // Mark element as flagged
                iframeFlaggedElements.push(element);
              }
              // If the element has a shadowRoot, add its children
              if (element.shadowRoot) {
                iframeElements.push(
                  ...(Array.from(element.shadowRoot.querySelectorAll('*')) as HTMLElement[]),
                );
              }
              indexOfIframeElements++;
            }
            const iframeXPath = getXPath(frame);
            currentFlaggedElementsByDocument[iframeXPath] = iframeFlaggedElements;
          }
        } catch (error) {
          console.warn(`Cannot access iframe document (${index}): ${error.message}`);
        }
      });

      // Collect XPaths and outerHTMLs of flagged elements per document
      const flaggedXPathsByDocument = {};

      for (const docKey in currentFlaggedElementsByDocument) {
        const elements = currentFlaggedElementsByDocument[docKey];
        const flaggedInfo = []; // Array to hold flagged element info
        elements.forEach(flaggedElement => {
          const parentFlagged = flaggedElement.closest('[data-flagged="true"]');
          if (!parentFlagged || parentFlagged === flaggedElement) {
            let xpath = getXPath(flaggedElement);
            if (docKey !== '') {
              // For elements in iframes, adjust XPath
              xpath = docKey + xpath;
            }
            if (xpath && flaggedElement !== null && flaggedElement.outerHTML) {
              const { outerHTML } = flaggedElement; // Get outerHTML
              flaggedInfo.push({ xpath, code: outerHTML }); // Store xpath and outerHTML

              // Check if the xpath already exists in previousAllFlaggedElementsXPaths
              const alreadyExists = previousAllFlaggedElementsXPaths.some(
                entry => entry.xpath === xpath,
              );
              if (!alreadyExists) {
                // Add to previousAllFlaggedElementsXPaths only if not already present
                previousAllFlaggedElementsXPaths.push({ xpath, code: outerHTML });
              }
            }
          }
        });
        flaggedXPathsByDocument[docKey] = flaggedInfo; // Store all flagged element info
      }

      // Update previousFlaggedXPathsByDocument before finishing
      previousFlaggedXPathsByDocument = { ...flaggedXPathsByDocument };

      cleanupFlaggedElements();
      console.timeEnd('Accessibility Check Time');
      return previousAllFlaggedElementsXPaths;
    }

    // Clean up [data-flagged="true"] attribute added by this script
    function cleanupFlaggedElements() {
      const flaggedElements = document.querySelectorAll('[data-flagged="true"]');
      flaggedElements.forEach(flaggedElement => {
        flaggedElement.removeAttribute('data-flagged');
      });
    }
    function debounce(func, wait) {
      let timeout;
      return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
      };
    }

    return flagElements();
  });
};
