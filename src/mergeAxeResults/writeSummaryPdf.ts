import fs from 'fs-extra';
import constants from '../constants/constants.js';
import { getPlaywrightLaunchOptions } from '../constants/common.js';
import { register } from '../utils.js';

const writeSummaryPdf = async (
  storagePath: string,
  pagesScanned: number,
  filename = 'summary',
  browser: string,
  _userDataDirectory: string,
): Promise<void> => {
  const htmlFilePath = `${storagePath}/${filename}.html`;
  const fileDestinationPath = `${storagePath}/${filename}.pdf`;

  const launchOptions = getPlaywrightLaunchOptions(browser);

  const browserInstance = await constants.launcher.launch({
    ...launchOptions,
    headless: true, // force headless for PDF
  });

  register(browserInstance as unknown as { close: () => Promise<void> });

  const context = await browserInstance.newContext();
  const page = await context.newPage();

  const data = fs.readFileSync(htmlFilePath, { encoding: 'utf-8' });
  await page.setContent(data, { waitUntil: 'domcontentloaded' });

  await page.emulateMedia({ media: 'print' });

  await page.pdf({
    margin: { bottom: '32px' },
    path: fileDestinationPath,
    format: 'A4',
    displayHeaderFooter: true,
    footerTemplate: `
    <div style="margin-top:50px;color:#26241b;font-family:Open Sans;text-align: center;width: 100%;font-weight:400">
      <span style="color:#26241b;font-size: 14px;font-weight:400">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
    </div>
  `,
  });

  await page.close();
  await context.close().catch(() => {});
  await browserInstance.close().catch(() => {});

  if (pagesScanned < 2000) {
    fs.unlinkSync(htmlFilePath);
  }
};

export default writeSummaryPdf;
