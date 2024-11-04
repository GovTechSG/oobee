import { Page } from 'playwright';
import textReadability from 'text-readability';

export async function extractAndGradeText(page: Page): Promise<{ readabilityScore: number; textContent: string; error?: string }> {
  try {
    // Extract text content from the page
    const textContent = await page.evaluate(() => {
      return document.body.innerText; // or any specific selector
    });

    // Trim whitespace from the extracted text
    const trimmedText = textContent.trim();

    // Check if the text content is valid for readability assessment
    if (trimmedText.length === 0) {
      return { readabilityScore: 0, textContent: '', error: 'No text content found.' };
    }

    // Grade the text content using the text-readability library
    const readabilityScore = textReadability.fleschReadingEase(trimmedText); // or other metrics as needed

    return { readabilityScore, textContent: trimmedText };
  } catch (error) {
    console.error('Error extracting and grading text:', error);
    return { readabilityScore: 0, textContent: '', error: 'Error processing the page.' };
  }
}
