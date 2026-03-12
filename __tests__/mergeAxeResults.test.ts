/* eslint-disable no-underscore-dangle */
/* eslint-disable no-undef */
import { jest } from '@jest/globals';
import printMessage from 'print-message';
import fs from 'fs-extra';
import path from 'path';
import Mustache from 'mustache';

import privateFuncs from '../mergeAxeResults.js';

const issueCountMap = privateFuncs.__get__('issueCountMap');
const thresholdLimitCheck = privateFuncs.__get__('thresholdLimitCheck');
const extractFileNames = privateFuncs.__get__('extractFileNames');
const parseContentToJson = privateFuncs.__get__('parseContentToJson');
const granularReporting = privateFuncs.__get__('granularReporting');
const writeHTML = privateFuncs.__get__('writeHTML');
const writeResults = privateFuncs.__get__('writeResults');

const {
  allIssues,
  allExceptCritical,
  allExceptModerate,
  allExceptSerious,
  allExceptMinor,
  criticalOnly,
  seriousOnly,
  moderateOnly,
  minorOnly,
} = require('../__mocks__/mockIssues');

const {
  createIssueCountMap,
  createAlertMessage,
  createFilenames,
  createFinalResultsInJson,
} = require('../__mocks__/mockFunctions');
const { getCurrentDate, getFormattedTime } = require('../src/utils/index.js');
const { consoleLogger, silentLogger } = require('../logs');

let randomToken;
let currentDate;
let expectedStoragePath;
let expectedJsonFilename;
let expectedHTMLFilename;
let htmlFilename;
let jsonFilename;

jest.mock('print-message');
jest.mock('fs-extra');
jest.mock('mustache');

beforeEach(() => {
  randomToken = '162282454060d4c8470d';
  currentDate = getCurrentDate();
  expectedStoragePath = `results/${currentDate}/${randomToken}`;

  // Reports storagePath, expected report and compiled result files
  htmlFilename = 'report';
  expectedHTMLFilename = `${expectedStoragePath}/${htmlFilename}.html`;

  // Mock the JSON result generated from the issues
  dateTimeStamp = getFormattedTime();
  jsonOutput = createFinalResultsInJson(allIssues, dateTimeStamp);
});

// Test issueCountMap
describe('test breakdown of issue counts', () => {
  test('should return map of 0 for no issues', () => {
    const result = issueCountMap([]);
    expect(result).toEqual(
      new Map([
        ['critical', 0],
        ['serious', 0],
        ['moderate', 0],
        ['minor', 0],
        ['total', 0],
      ]),
    );
  });

  test('should return map of issue counts', () => {
    const result = issueCountMap(allIssues);
    expect(result).toEqual(
      new Map([
        ['critical', 1],
        ['serious', 1],
        ['moderate', 1],
        ['minor', 1],
        ['total', 4],
      ]),
    );
  });
});

// Test thresholdLimitCheck
describe('test threshold limit check', () => {
  const mockIssueCountMap = mockData => {
    privateFuncs.__set__('issueCountMap', mockData)();
  };

  beforeEach(() => {
    warnlevel = 'none';
    expectedIssueCountMap = [];
  });

  afterEach(() => {
    printMessage.mockReset();
  });

  test('should print issue count with no trigger if warnlevel is none', async () => {
    expectedIssueCountMap = createIssueCountMap(1, 1, 1, 1);
    mockIssueCountMap(expectedIssueCountMap);

    await thresholdLimitCheck(warnlevel, allIssues);
    expect(printMessage).toHaveBeenCalled();
    expect(printMessage.mock.calls.length).toEqual(1);
    expect(printMessage.mock.calls[0][0]).toEqual(expectedIssueCountMap);
  });

  test.each([
    ['critical', allExceptCritical, createIssueCountMap(0, 1, 1, 1)],
    ['serious', allExceptSerious, createIssueCountMap(1, 0, 1, 1)],
    ['moderate', allExceptModerate, createIssueCountMap(1, 1, 0, 1)],
    ['minor', allExceptMinor, createIssueCountMap(1, 1, 1, 0)],
  ])(
    'should print issue count only if all issues except %s issues are present',
    async (warnlevel, data, expected) => {
      mockIssueCountMap(data);

      await thresholdLimitCheck(warnlevel, data);
      expect(printMessage).toHaveBeenCalled();
      expect(printMessage.mock.calls.length).toEqual(1);
      expect(printMessage.mock.calls[0][0]).toEqual(expected);
    },
  );

  test.each([
    ['critical', criticalOnly, createIssueCountMap(1, 0, 0, 0)],
    ['serious', seriousOnly, createIssueCountMap(0, 1, 0, 0)],
    ['moderate', moderateOnly, createIssueCountMap(0, 0, 1, 0)],
    ['minor', minorOnly, createIssueCountMap(0, 0, 0, 1)],
  ])(
    'should print issue count and alert message if %s issues are present',
    async (warnlevel, data, expected) => {
      const expectedAlertMessage = createAlertMessage(warnlevel);
      mockIssueCountMap(data);

      await thresholdLimitCheck(warnlevel, data);
      expect(printMessage).toHaveBeenCalled();
      expect(printMessage.mock.calls.length).toEqual(2);
      expect(printMessage.mock.calls[0][0]).toEqual(expected);
      expect(printMessage.mock.calls[1]).toEqual(expectedAlertMessage);
    },
  );
});

describe('test parsing content to json', () => {
  test('should return JSON', async () => {
    fs.readFile.mockResolvedValue('{ "a": 1 }');
    const expected = { a: 1 };
    const result = await parseContentToJson('path');
    expect(result).toMatchObject(expected);
  });

  test('should print error message when unable to parse content', async () => {
    fs.readFile.mockResolvedValue(undefined);
    await parseContentToJson('path');
    const spyConsoleLogger = jest.spyOn(consoleLogger, 'info').mockImplementation();
    const spySilentLogger = jest.spyOn(silentLogger, 'error').mockImplementation();

    expect(spyConsoleLogger.mock.calls[0][0]).toEqual(
      'An error has occurred when parsing the content, please try again.',
    );

    expect(spySilentLogger.mock.calls[0][0].toString()).toMatch(
      new RegExp(/SyntaxError\:[\s]+Unexpected token.*JSON/),
    );
  });
});

describe('test write results', () => {
  afterEach(() => {
    fs.writeFile.mockReset();
  });

  test('should create compiled json file with intended filename', async () => {
    fs.writeFile.mockResolvedValue();
    await writeResults(allIssues, expectedStoragePath, jsonFilename);

    expect(fs.writeFile).toHaveBeenCalled();
    expect(fs.writeFile.mock.calls[0][0]).toEqual(expectedJsonFilename);
    expect(fs.writeFile.mock.calls[0][1]).toEqual(jsonOutput);
  });

  test('should fail if there is error writing to JSON file', async () => {
    fs.writeFile.mockImplementation(() => {
      throw new Error();
    });

    const spyConsoleLogger = jest.spyOn(consoleLogger, 'info').mockImplementation();
    const spySilentLogger = jest.spyOn(silentLogger, 'error').mockImplementation();

    await writeResults(allIssues, expectedStoragePath, jsonFilename);
    expect(fs.writeFile).toThrowError();
    expect(spyConsoleLogger.mock.calls[0][0]).toEqual(
      'An error has occurred when compiling the results into the report, please try again.',
    );
    expect(spySilentLogger.mock.calls[0][0].toString()).toEqual('(writeResults) - Error');
  });
});

describe('test write results into HTML report', () => {
  beforeAll(() => {
    // Reports Templates and Content
    const originalFs = jest.requireActual('fs-extra');
    const mustacheReportfile = path.resolve('./static/report.mustache');
    const mockReportFile = path.resolve('./__mocks__/mock-report.html');

    mustacheTemp = originalFs.readFileSync(mustacheReportfile, 'utf8', data => data);
    mockReportContent = originalFs.readFileSync(mockReportFile, 'utf8', data => data);
  });

  afterEach(() => {
    fs.readFile.mockReset();
    fs.writeFile.mockReset();
    Mustache.render.mockReset();
  });

  test('should create HTML report with intended filename', async () => {
    fs.readFile.mockResolvedValue(mustacheTemp);
    Mustache.render.mockResolvedValue(mockReportContent);
    await writeHTML(allIssues, expectedStoragePath, htmlFilename);

    expect(fs.readFile).toHaveBeenCalled();
    expect(Mustache.render).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalled();

    expect(fs.readFile.mock.results[0].value).resolves.toEqual(mustacheTemp);
    expect(Mustache.render.mock.results[0].value).resolves.toEqual(mockReportContent);
    expect(fs.writeFile.mock.calls[0][0]).toEqual(expectedHTMLFilename);
    expect(fs.writeFile.mock.calls[0][1]).resolves.toEqual(mockReportContent);
  });

  test('should fail if unable to read the template file', async () => {
    fs.readFile.mockImplementation(() => {
      throw new Error();
    });

    const spyConsoleLogger = jest.spyOn(consoleLogger, 'info').mockImplementation();
    const spySilentLogger = jest.spyOn(silentLogger, 'error').mockImplementation();
    await writeHTML(allIssues, expectedStoragePath, htmlFilename);
    expect(fs.readFile).toThrowError();
    expect(spyConsoleLogger.mock.calls[0][0]).toEqual(
      'An error has occurred when generating the report, please try again.',
    );
    expect(spySilentLogger.mock.calls[0][0].toString()).toEqual('(writeHTML) - Error');
  });
});

describe('test granular reporting feature', () => {
  afterEach(() => {
    privateFuncs.__get__('writeHTML');
    privateFuncs.__get__('writeResults');
  });

  test('should return false when there are no issues', async () => {
    const noIssues = [];
    const result = await granularReporting(randomToken, noIssues);
    expect(result).toBe(false);
  });

  test('should return true and generate the graular reports along with main reports', async () => {
    privateFuncs.__set__('writeResults', jest.fn());
    privateFuncs.__set__('writeHTML', jest.fn());
    const result = await granularReporting(randomToken, allIssues);
    expect(result).toBe(true);
  });
});
