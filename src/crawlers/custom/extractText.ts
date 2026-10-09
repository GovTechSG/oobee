export function extractText(): string[] {
  try {
    // Extract text content from all specified elements (e.g., paragraphs)
    const elements = document.querySelectorAll('p'); // Adjust selector as needed
    const extractedSentences: string[] = [];
    // asgard-0005: bound the text returned to Node. Same value as
    // MAX_READABILITY_TEXT_CHARS in gradeReadability.ts, which grades at most
    // this much anyway, so stopping here changes no score. Must stay inline:
    // this function is serialised via toString() and runs in the page.
    const maxChars = 1_000_000;
    // asgard-0004 (2026-10-09 re-scan): bound each paragraph BEFORE the
    // terminator scan / match() below. Without this, a single huge <p> (tens
    // of MB) forced an O(paragraph-size) match() allocation per paragraph,
    // regardless of maxChars — that only bounds total pushed OUTPUT, checked
    // after match() already ran. No real paragraph approaches this size.
    const maxParagraphChars = maxChars;
    let totalChars = 0;
    let stop = false;

    elements.forEach(element => {
      if (stop) return;
      const rawText = element.innerText.trim().slice(0, maxParagraphChars);
      // Drop the trailing run after the last terminator: it can never match, and it is
      // the only input on which the regex below backtracks quadratically.
      // Kept inline since this function is serialised via toString().
      let lastTerminator = -1;
      for (let j = rawText.length - 1; j >= 0; j -= 1) {
        const c = rawText[j];
        if (c === '.' || c === '!' || c === '?') {
          lastTerminator = j;
          break;
        }
      }
      if (lastTerminator < 0) return;
      const text = rawText.slice(0, lastTerminator + 1);
      // Split the text into individual sentences
      const sentencePattern = /[^.!?]*[.!?]+/g; // Match sentences ending with ., !, or ?
      const matches = text.match(sentencePattern);
      if (matches) {
        // Add only sentences that end with punctuation
        for (const sentence of matches) {
          const trimmedSentence = sentence.trim(); // Trim whitespace from each sentence
          if (trimmedSentence.length === 0) continue;
          if (totalChars + trimmedSentence.length > maxChars) {
            stop = true;
            break;
          }
          extractedSentences.push(trimmedSentence);
          totalChars += trimmedSentence.length + 1; // +1 for gradeReadability's join separator
        }
      }
    });

    return extractedSentences;
  } catch (error) {
    console.error('Error extracting text:', error);
    return []; // Return an empty string in case of an error
  }
}
