describe('template spec', () => {
  beforeEach(() => {
    cy.visit('https://govtechsg.github.io/purple-banner-embeds/purple-integrated-scan-example.htm');
    cy.injectOobeeA11yScripts();
  });

  after(() => {
    cy.terminateOobeeA11y();
  });

  it('should not have WCAG violations in first section', () => {
    cy.runOobeeA11yScan({}, { mustFix: 10 });
  });

  it('should not have WCAG violations in second section', () => {
    cy.get('button[onclick="toggleSecondSection()"]').click();
    // Run a scan on <input> and <button> elements
    cy.runOobeeA11yScan(
      {
        elementsToScan: ['input', 'button'],
        elementsToClick: ['button[onclick="toggleSecondSection()"]'],
        metadata: 'Clicked button',
      },
      { mustFix: 1 },
    );
  });
});
