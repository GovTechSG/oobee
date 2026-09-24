// Oobee report metadata guard; this is not an HTML title standard.
export const MAX_REPORT_TITLE_LENGTH = 512;
// ASCII control characters, including newlines, null bytes, and DEL.
const CONTROL_CHARACTERS_REGEX = /[\u0000-\u001f\u007f]/g;

const normalizeEnvValue = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(CONTROL_CHARACTERS_REGEX, '').trim();
  return normalized.length > 0 ? normalized : undefined;
};

export const sanitizeReportTitle = (title: string): string => {
  const stripped = title.replace(CONTROL_CHARACTERS_REGEX, '').trim();
  return stripped.length > MAX_REPORT_TITLE_LENGTH
    ? stripped.slice(0, MAX_REPORT_TITLE_LENGTH)
    : stripped;
};

export const resolveReportMetadataOverrides = () => {
  const pageTitle = normalizeEnvValue(process.env.OOBEE_REPORT_PAGE_TITLE);
  const pageUrl = normalizeEnvValue(process.env.OOBEE_REPORT_PAGE_URL);

  return {
    ...(pageTitle && { pageTitle: sanitizeReportTitle(pageTitle) }),
    ...(pageUrl && { pageUrl }),
  };
};
