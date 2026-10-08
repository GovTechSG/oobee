export function extractText(): string[] {
  try {
    // Extract text content from all specified elements (e.g., paragraphs)
    const elements = document.querySelectorAll('p'); // Adjust selector as needed
    const extractedSentences: string[] = [];

    elements.forEach(element => {
      const rawText = element.innerText.trim();
      // Drop the trailing run after the last terminator: it can never match, and it is
      // the only input on which the regex below backtracks quadratically. No length cap,
      // because integrators feed this output to gradeReadability and truncation would
      // skew their scores. Kept inline since this function is serialised via toString().
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
        matches.forEach(sentence => {
          const trimmedSentence = sentence.trim(); // Trim whitespace from each sentence
          if (trimmedSentence.length > 0) {
            extractedSentences.push(trimmedSentence);
          }
        });
      }
    });

    return extractedSentences;
  } catch (error) {
    console.error('Error extracting text:', error);
    return []; // Return an empty string in case of an error
  }
}
