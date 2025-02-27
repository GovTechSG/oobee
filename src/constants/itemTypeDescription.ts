const itemTypeDescription = {
  mustFix:
    'Must Fix issues includes WCAG A & AA success criteria (excluding those requiring review).',
  goodToFix:
    'Good to Fix issues includes WCAG Level AAA success criteria issues and all best practice rules that do not necessarily conform to WCAG success criterion but are industry accepted practices that improve the user experience.',
  needsReview:
    'Manual Review Required occurrences could potentially be false positive, requiring human validation for accuracy.',
  passed: 'Occurrences that passed the automated checks.',
};

export default itemTypeDescription;
