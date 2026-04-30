#!/usr/bin/env node
import printMessage from 'print-message';
import inquirer from 'inquirer';
import { getVersion, getUserDataTxt, writeToUserDataTxt, listenForCleanUp, cleanUpAndExit, } from './utils.js';
import { prepareData, messageOptions, getPlaywrightDeviceDetailsObject, getScreenToScan, getClonedProfilesWithRandomToken, } from './constants/common.js';
import questions from './constants/questions.js';
import combineRun from './combine.js';
import { FileTypes } from './constants/constants.js';
const userData = getUserDataTxt();
const runScan = async (answers) => {
    const screenToScan = getScreenToScan(answers.deviceChosen, answers.customDevice, answers.viewportWidth);
    answers.playwrightDeviceDetailsObject = getPlaywrightDeviceDetailsObject(answers.deviceChosen, answers.customDevice, answers.viewportWidth);
    if (!answers.nameEmail) {
        answers.nameEmail = `${userData.name}:${userData.email}`;
    }
    answers.fileTypes = FileTypes.All;
    answers.metadata = '{}';
    const data = await prepareData(answers);
    // Executes cleanUp script if error encountered
    listenForCleanUp(data.randomToken);
    data.userDataDirectory = getClonedProfilesWithRandomToken(data.browser, data.randomToken);
    printMessage(['Scanning website...'], messageOptions);
    await combineRun(data, screenToScan);
    // Delete dataset and request queues
    cleanUpAndExit(0, data.randomToken);
};
if (userData) {
    printMessage([
        `Oobee (ver ${getVersion()})`,
        'We recommend using Chrome browser for the best experience.',
        '',
        `Welcome back ${userData.name}!`,
        `(Refer to readme.txt on how to change your profile)`,
    ], {
        // Note that the color is based on kleur NPM package
        border: true,
        borderColor: 'magenta',
    });
    inquirer.prompt(questions).then(async (answers) => {
        await runScan(answers);
    });
}
else {
    printMessage([`Oobee (ver ${getVersion()})`, 'We recommend using Chrome browser for the best experience.'], {
        // Note that the color is based on kleur NPM package
        border: true,
        borderColor: 'magenta',
    });
    printMessage([
        `To personalise your experience, we will be collecting your name, email address and app usage data.`,
        `Your information fully complies with GovTech's Privacy Policy.`,
    ], {
        border: false,
    });
    inquirer.prompt(questions).then(async (answers) => {
        const { name, email } = answers;
        answers.nameEmail = `${name}:${email}`;
        await writeToUserDataTxt('name', name);
        await writeToUserDataTxt('email', email);
        await runScan(answers);
    });
}
