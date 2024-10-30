import { Page } from 'playwright';
import * as fs from 'fs';

// Function to scrape text content from a given URL
export const scrapeTextContent = async (page: Page, url: string, minWordCount: number): Promise<string | null> => {
  const validSentences = await page.evaluate(async (url: string) => {
    const sentences: string[] = [];

    // Fetch the HTML content from the given URL
    const response = await fetch(url);
    const html = await response.text();
    const domParser = new DOMParser();
    const doc = domParser.parseFromString(html, 'text/html');
    const elements = Array.from(doc.querySelectorAll('p')).filter(el => el.textContent.trim() !== '');

    for (const element of elements) {
      const textContent = element.innerText;
      const matchedSentences = textContent.match(/[^.!?]+[.!?]+/g) || [];
      const filteredSentences = matchedSentences.filter(sentence => sentence.trim().length >= 5);
      sentences.push(...filteredSentences.map(sentence => sentence.trim()));
    }

    return sentences; // Return the valid sentences
  }, url);

  const concatenatedSentences = validSentences.join(' ');
  const wordCount = concatenatedSentences.split(/\s+/).length;

  if (wordCount >= minWordCount) {
    // Write the valid sentences to a file using Node.js fs module
    await fs.promises.writeFile('cleanedTextContent.txt', concatenatedSentences);
    console.log('Text saved to cleanedTextContent.txt');
    return concatenatedSentences;
  } else {
    console.log('Not enough data to give an accurate grade. Best to have manual testing.');
    return null;
  }
};