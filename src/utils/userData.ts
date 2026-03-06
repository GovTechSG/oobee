import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';

export const getUserDataFilePath = () => {
  const platform = os.platform();
  if (platform === 'win32') {
    return path.join(process.env.APPDATA, 'Oobee', 'userData.txt');
  }
  if (platform === 'darwin') {
    return path.join(process.env.HOME, 'Library', 'Application Support', 'Oobee', 'userData.txt');
  }
  // linux and other OS
  return path.join(process.env.HOME, '.config', 'oobee', 'userData.txt');
};

export const getUserDataTxt = () => {
  const textFilePath = getUserDataFilePath();

  // check if textFilePath exists
  if (fs.existsSync(textFilePath)) {
    const userData = JSON.parse(fs.readFileSync(textFilePath, 'utf8'));
    // If userId doesn't exist, generate one and save it
    if (!userData.userId) {
      userData.userId = uuidv4();
      fs.writeFileSync(textFilePath, JSON.stringify(userData, null, 2));
    }
    return userData;
  }
  return null;
};

export const writeToUserDataTxt = async (key: string, value: string): Promise<void> => {
  const textFilePath = getUserDataFilePath();

  // Create file if it doesn't exist
  if (fs.existsSync(textFilePath)) {
    const userData = JSON.parse(fs.readFileSync(textFilePath, 'utf8'));
    userData[key] = value;
    // Ensure userId exists
    if (!userData.userId) {
      userData.userId = uuidv4();
    }
    fs.writeFileSync(textFilePath, JSON.stringify(userData, null, 2));
  } else {
    const textFilePathDir = path.dirname(textFilePath);
    if (!fs.existsSync(textFilePathDir)) {
      fs.mkdirSync(textFilePathDir, { recursive: true });
    }
    // Initialize with userId
    fs.appendFileSync(textFilePath, JSON.stringify({ [key]: value, userId: uuidv4() }, null, 2));
  }
};
