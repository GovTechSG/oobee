const getHost = (url: string): string => new URL(url).host;

export default getHost;
