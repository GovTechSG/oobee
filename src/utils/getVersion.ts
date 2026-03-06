import fs from 'fs-extra';

const getVersion = (): string => {
  const loadJSON = (filePath: string): { version: string } =>
    JSON.parse(fs.readFileSync(new URL(filePath, import.meta.url)).toString());
  return loadJSON('../../package.json').version;
};

export default getVersion;
