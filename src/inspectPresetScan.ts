import { parseBooleanValue } from './envUtils.js';

export const INSPECT_PRESET_SCAN_ENV = 'OOBEE_INSPECT_PRESET_SCAN';

export const resolveInspectPresetScanEnabled = (): boolean => {
  return parseBooleanValue(process.env[INSPECT_PRESET_SCAN_ENV]) ?? false;
};

const inspectPresetDateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const resolveDateOrToday = (date: Date): Date => {
  if (Number.isNaN(date.getTime())) {
    return new Date();
  }

  return date;
};

export const formatInspectPresetScanDate = (date: Date): string => {
  return inspectPresetDateFormatter.format(resolveDateOrToday(date));
};
