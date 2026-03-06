// areLinksEqual compares 2 string URLs and ignores comparison of 'www.' and url protocol
// i.e. 'http://google.com' and 'https://www.google.com' returns true
export const areLinksEqual = (link1: string, link2: string): boolean => {
  try {
    const format = (link: string): URL => {
      return new URL(link.replace(/www\./, ''));
    };
    const l1 = format(link1);
    const l2 = format(link2);

    const areHostEqual = l1.host === l2.host;
    const arePathEqual = l1.pathname === l2.pathname;

    return areHostEqual && arePathEqual;
  } catch {
    return link1 === link2;
  }
};

export const isFollowStrategy = (link1: string, link2: string, rule: string): boolean => {
  const parsedLink1 = new URL(link1);
  const parsedLink2 = new URL(link2);
  if (rule === 'same-domain') {
    const link1Domain = parsedLink1.hostname.split('.').slice(-2).join('.');
    const link2Domain = parsedLink2.hostname.split('.').slice(-2).join('.');
    return link1Domain === link2Domain;
  }
  return parsedLink1.hostname === parsedLink2.hostname;
};
