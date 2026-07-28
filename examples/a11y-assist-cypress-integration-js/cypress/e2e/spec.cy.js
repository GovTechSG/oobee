describe("template spec", () => {
  it("should run a11yassist A11y", () => {
    cy.visit(
      "https://govtechsg.github.io/purple-banner-embeds/purple-integrated-scan-example.htm"
    );
    cy.injectA11yAssistA11yScripts();
    cy.runA11yAssistA11yScan();
    
    cy.get("button[onclick=\"toggleSecondSection()\"]").click();
    // Run a scan on <input> and <button> elements
    cy.runA11yAssistA11yScan({
      elementsToScan: ["input", "button"],
      elementsToClick: ["button[onclick=\"toggleSecondSection()\"]"],
      metadata: "Clicked button"
    });

    cy.terminateA11yAssistA11y();
  });
});
