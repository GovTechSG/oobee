export function extractText(): string[] {
  try {
    // Extract text content from all specified elements (e.g., paragraphs)
    const elements = document.querySelectorAll('p'); // Adjust selector as needed
    const extractedSentences: string[] = [];

    elements.forEach(element => {
      const text = element.innerText.trim();
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
