import fs from 'fs-extra';
const getVersion = () => {
    const loadJSON = (filePath) => JSON.parse(fs.readFileSync(new URL(filePath, import.meta.url)).toString());
    return loadJSON('../../package.json').version;
};
export default getVersion;
