describe("template spec", () => {
  it("should run oobee A11y", () => {
    cy.visit(
      "https://govtechsg.github.io/purple-banner-embeds/purple-integrated-scan-example.htm"
    );
    cy.injectOobeeA11yScripts();
    cy.runOobeeA11yScan();
    
    cy.get("button[onclick=\"toggleSecondSection()\"]").click();
    // Run a scan on <input> and <button> elements
    cy.runOobeeA11yScan({
      elementsToScan: ["input", "button"],
      elementsToClick: ["button[onclick=\"toggleSecondSection()\"]"],
      metadata: "Clicked button"
    });

    cy.terminateOobeeA11y();
  });
});
