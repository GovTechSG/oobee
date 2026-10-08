import { Page } from 'playwright';
import textReadability from 'text-readability';

// Caps on how much page text we pull back into Node. Reading-ease grading
// does not need the full document — 200k characters is >> any realistic
// article-length page, and the per-<p> cap prevents a single attacker-
// controlled paragraph from dominating memory. Both budgets are enforced
// inside page.evaluate so we never materialise the oversized text in Node.
const MAX_PARAGRAPHS = 2000;
const MAX_TEXT_CHARS = 200_000;

export async function extractAndGradeText(page: Page): Promise<string> {
  try {
    // Extract text content from all specified elements (e.g., paragraphs)
    const sentences: string[] = await page.evaluate(
      ({ maxParagraphs, maxChars }) => {
        const elements = document.querySelectorAll('p'); // Adjust selector as needed
        const extractedSentences: string[] = [];
        let totalChars = 0;
        const limit = Math.min(elements.length, maxParagraphs);

        for (let i = 0; i < limit; i += 1) {
          const element = elements[i] as HTMLElement;
          const rawText = element.innerText.trim();
          // The sentence regex only backtracks quadratically on a trailing run with
          // no terminator (every start position scans to the end and fails). That
          // tail can never yield a match, so dropping it first is output-identical
          // and keeps match() linear. Slicing to maxChars instead would still allow
          // ~18s per 200k-char paragraph and would also truncate real sentences.
          let lastTerminator = -1;
          for (let j = rawText.length - 1; j >= 0; j -= 1) {
            const c = rawText[j];
            if (c === '.' || c === '!' || c === '?') {
              lastTerminator = j;
              break;
            }
          }
          if (lastTerminator < 0) continue;
          const text = rawText.slice(0, lastTerminator + 1);
          const sentencePattern = /[^.!?]*[.!?]+/g; // Match sentences ending with ., !, or ?
          const matches = text.match(sentencePattern);
          if (!matches) continue;
          let stop = false;
          for (const sentence of matches) {
            const trimmedSentence = sentence.trim();
            if (trimmedSentence.length === 0) continue;
            if (totalChars + trimmedSentence.length > maxChars) {
              stop = true;
              break;
            }
            extractedSentences.push(trimmedSentence);
            totalChars += trimmedSentence.length + 1; // +1 for the join separator
          }
          if (stop) break;
        }

        return extractedSentences;
      },
      { maxParagraphs: MAX_PARAGRAPHS, maxChars: MAX_TEXT_CHARS },
    );

    // Check if any valid sentences were extracted
    if (sentences.length === 0) {
      return ''; // Return an empty string if no valid sentences are found
    }

    // Join the valid sentences into a single string. slice() is a defence-in-
    // depth guard in case a future page.evaluate change removes the in-page cap.
    const filteredText = sentences.join(' ').trim().slice(0, MAX_TEXT_CHARS);

    // Count the total number of words in the filtered text
    const wordCount = filteredText.split(/\s+/).length;

    // Grade the text content only if there are 20 words or more
    const readabilityScore = wordCount >= 20 ? textReadability.fleschReadingEase(filteredText) : 0;

    // Log details for debugging

    // Determine the return value
    const result =
      readabilityScore <= 0 || readabilityScore > 50 ? '' : readabilityScore.toString();

    return result;
  } catch (error) {
    console.warn('Error extracting and grading text:', error);
    return ''; // Return an empty string in case of an error
  }
}
