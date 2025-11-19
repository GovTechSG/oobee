import path from 'path';
import { generateHtmlReport } from './generateHtmlReport.js';

async function main() {
  const dirArg = process.argv[2];

  if (!dirArg) {
    console.error('Usage: npx tsx src/dev-generate-from-existing.ts <results-dir>');
    process.exit(1);
  }

  const resultDir = path.resolve(process.cwd(), dirArg);
  const out = await generateHtmlReport(resultDir);
  console.log('\nOpen:', out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
