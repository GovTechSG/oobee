const isWhitelistedContentType = (contentType: string): boolean => {
  const whitelist = ['text/html'];
  return whitelist.filter(type => contentType.trim().startsWith(type)).length === 1;
};

export default isWhitelistedContentType;
