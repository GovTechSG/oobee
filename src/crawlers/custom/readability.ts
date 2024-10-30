import * as fs from 'fs';
import textReadability from 'text-readability';

// Function to calculate and print readability scores
export const calculateReadability = async (filePath: string) => {
  try {
    const data = await fs.promises.readFile(filePath, 'utf8'); // Use promises for consistency

    console.log(`Flesch Kincaid Grade Level: ${textReadability.fleschKincaid(data)}`);
    console.log(`Flesch Kincaid Reading Ease: ${textReadability.fleschReadingEase(data)}`);
  } catch (err) {
    console.error(`Error reading file: ${err}`);
  }
};
