import { Page } from 'playwright';
import * as fs from 'fs';
import textReadability from 'text-readability';

// Function to scrape text content from a webpage
export const scrapeTextContent = async (page: Page): Promise<string | null> => {
  const validSentences = await page.evaluate(() => {
    const sentences: string[] = [];
    const elements = Array.from(document.querySelectorAll('p')).filter(el => el.textContent.trim() !== '');

    for (const element of elements) {
      const textContent = element.innerText;
      const matchedSentences = textContent.match(/[^.!?]+[.!?]+/g) || [];
      const filteredSentences = matchedSentences.filter(sentence => sentence.trim().length >= 5);
      sentences.push(...filteredSentences.map(sentence => sentence.trim()));
    }

    return sentences; // Return the valid sentences
  });

  const concatenatedSentences = validSentences.join(' ');

  // Write the valid sentences to a file using Node.js fs module
  await fs.promises.writeFile('cleanedTextContent.txt', concatenatedSentences);
  console.log('Text saved to cleanedTextContent.txt');
  
  return concatenatedSentences;
};

// Function to calculate and print readability scores
export const calculateReadability = async (filePath: string) => {
  try {
    const data = await fs.promises.readFile(filePath, 'utf8');

    console.log(`Flesch Kincaid Grade Level: ${textReadability.fleschKincaid(data)}`);
    console.log(`Flesch Kincaid Reading Ease: ${textReadability.fleschReadingEase(data)}`);
  } catch (err) {
    console.error(`Error reading file: ${err}`);
  }
};