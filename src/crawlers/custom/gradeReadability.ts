import textReadability from 'text-readability';

// asgard-0005: upper bound on the text graded per call. gradeReadability is
// public API and is fed page-derived text (e.g. extractText() output from an
// untrusted site), so without a cap a page with tens of MB of <p> text forces
// one giant string allocation plus a full readability pass over it.
//
// Deliberately large: text-readability is linear (~350 ms per 1M chars on
// typical prose), and 1M chars is ~150k words — far beyond any real page — so
// legitimate scores are unchanged. Flesch reading ease is an average over
// sentences and words, so grading the first 1M chars of a larger text gives
// effectively the same score.
export const MAX_READABILITY_TEXT_CHARS = 1_000_000;

// Joins sentences with ' ' exactly like Array.prototype.join, but stops once
// the result would exceed maxChars, so the oversized string is never built.
// Stops on a sentence boundary; only a single oversized first sentence is cut.
const joinWithinLimit = (sentences: unknown[], maxChars: number): string => {
  const parts: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    const text = String(sentence ?? '');
    const added = (parts.length > 0 ? 1 : 0) + text.length;
    if (length + added > maxChars) {
      if (parts.length === 0) parts.push(text.slice(0, maxChars));
      break;
    }
    parts.push(text);
    length += added;
  }
  return parts.join(' ');
};

export function gradeReadability(sentences: string[]): string {
  try {
    // Check if any valid sentences were extracted
    if (!Array.isArray(sentences) || sentences.length === 0) {
      return ''; // Return an empty string if no valid sentences are found
    }

    // Join the valid sentences into a single string, bounded (asgard-0005).
    // slice() is a final guard so the graded text can never exceed the cap.
    const filteredText = joinWithinLimit(sentences, MAX_READABILITY_TEXT_CHARS)
      .trim()
      .slice(0, MAX_READABILITY_TEXT_CHARS);

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
