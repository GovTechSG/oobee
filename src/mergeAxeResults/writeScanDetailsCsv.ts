import fs from 'fs-extra';
import path from 'path';

const streamEncodedDataToFile = async (
  inputFilePath: string,
  writeStream: fs.WriteStream,
  appendComma: boolean,
) => {
  const readStream = fs.createReadStream(inputFilePath, { encoding: 'utf8' });
  let isFirstChunk = true;

  for await (const chunk of readStream) {
    if (isFirstChunk) {
      isFirstChunk = false;
      writeStream.write(chunk);
    } else {
      writeStream.write(chunk);
    }
  }

  if (appendComma) {
    writeStream.write(',');
  }
};

const writeScanDetailsCsv = async (
  scanDataFilePath: string,
  scanItemsFilePath: string,
  scanItemsSummaryFilePath: string,
  storagePath: string,
) => {
  const filePath = path.join(storagePath, 'scanDetails.csv');
  const csvWriteStream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  const directoryPath = path.dirname(filePath);

  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }

  csvWriteStream.write('scanData_base64,scanItems_base64,scanItemsSummary_base64\n');
  await streamEncodedDataToFile(scanDataFilePath, csvWriteStream, true);
  await streamEncodedDataToFile(scanItemsFilePath, csvWriteStream, true);
  await streamEncodedDataToFile(scanItemsSummaryFilePath, csvWriteStream, false);

  await new Promise((resolve, reject) => {
    csvWriteStream.end(resolve);
    csvWriteStream.on('error', reject);
  });
};

export default writeScanDetailsCsv;
