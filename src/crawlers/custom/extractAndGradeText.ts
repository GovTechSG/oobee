import { Page } from 'playwright';
import textReadability from 'text-readability';

export async function extractAndGradeText(page: Page): Promise<string> {
  try {
    // Extract text content from all specified elements (e.g., paragraphs)
    const sentences: string[] = await page.evaluate(() => {
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
    });

    // Check if any valid sentences were extracted
    if (sentences.length === 0) {
      return ''; // Return an empty string if no valid sentences are found
    }

    // Join the valid sentences into a single string
    const filteredText = sentences.join(' ').trim();

    // Count the total number of words in the filtered text
    const wordCount = filteredText.split(/\s+/).length;

    // Grade the text content only if there are 20 words or more
    const readabilityScore = wordCount >= 20 ? textReadability.fleschReadingEase(filteredText) : 0;

    // Log details for debugging

    // Determine the return value
    const result =
      readabilityScore === 0 || readabilityScore > 50 ? '' : readabilityScore.toString(); // Convert readabilityScore to string

    return result;
  } catch (error) {
    console.error('Error extracting and grading text:', error);
    return ''; // Return an empty string in case of an error
  }
}
