import textReadability from 'text-readability';

export function gradeReadability(sentences: string[]): string {
  try {
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
