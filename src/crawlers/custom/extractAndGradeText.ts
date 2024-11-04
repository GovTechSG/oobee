import { Page } from 'playwright';
import textReadability from 'text-readability';

export async function extractAndGradeText(page: Page): Promise<{ readabilityScore: number; textContent: string; error?: string }> {
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

    console.log('Extracted Sentences:', sentences); // Debug log

    // Check if any valid sentences were extracted
    if (sentences.length === 0) {
      console.log('No sentences found and extracted. Manual testing required.');
      return { readabilityScore: 0, textContent: '', error: 'No valid sentences found.' };
    }

    // Join the valid sentences into a single string
    const filteredText = sentences.join(' ').trim();
    console.log('Filtered Text:', filteredText); // Debug log

    // Count the total number of words in the filtered text
    const wordCount = filteredText.split(/\s+/).length;
    console.log('Word Count:', wordCount); // Debug log

    // Grade the text content only if there are 20 words or more
    const readabilityScore = wordCount >= 20 ? textReadability.fleschReadingEase(filteredText) : 0;

    // Final log statements to confirm function flow
    console.log('Readability Score:', readabilityScore); // Debug log

    // If word count is less than 20, print a message but continue to the final return statement
    if (wordCount < 20) {
        console.log('Not enough data to give an accurate grade. Best to have manual testing.');
    }  

    return { readabilityScore, textContent: filteredText };
  } catch (error) {
    console.error('Error extracting and grading text:', error);
    return { readabilityScore: 0, textContent: '', error: 'Error processing the page.' };
  }
}
