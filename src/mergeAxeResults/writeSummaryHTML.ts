import fs from 'fs-extra';
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AllIssues } from './types.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const writeSummaryHTML = async (
  allIssues: AllIssues,
  storagePath: string,
  htmlFilename = 'summary',
): Promise<void> => {
  const summaryTemplatePath = path.join(dirname, '../static/ejs/summary.ejs');
  const ejsString = fs.readFileSync(summaryTemplatePath, 'utf-8');
  const template = ejs.compile(ejsString, {
    filename: summaryTemplatePath,
  });
  const html = template(allIssues);
  fs.writeFileSync(`${storagePath}/${htmlFilename}.html`, html);
};

export default writeSummaryHTML;
