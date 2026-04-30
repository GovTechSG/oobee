// File used to hold sample data for unit testing
export const sampleXmlSitemap = `
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
  <!--  created with Free Online Sitemap Generator www.xml-sitemaps.com  -->
  <url>
    <loc>http://www.google.com/</loc>
    <lastmod>2023-01-17T02:49:19+00:00</lastmod>
    <priority>1.00</priority>
  </url>
  <url>
    <loc>http://www.google.com/intl/en/policies/privacy/</loc>
    <lastmod>2020-05-26T07:00:00+00:00</lastmod>
    <priority>0.80</priority>
  </url>
  <!-- <url>
<loc>http://www.google.com/intl/en/policies/terms/</loc>
<lastmod>2020-05-26T07:00:00+00:00</lastmod>
<priority>0.80</priority>
</url> -->
</urlset>`;
export const sampleXmlSitemapLinks = [
    'http://www.google.com/',
    'http://www.google.com/intl/en/policies/privacy/',
];
// Source: https://www.feedforall.com/sample-feed.xml
export const sampleRssFeed = `<?xml version="1.0" encoding="windows-1252"?>
<rss version="2.0">
  <channel>
    <title>Sample Feed - Favorite RSS Related Software &amp; Resources</title>
    <description>Take a look at some of FeedForAll&apos;s favorite software and resources for learning more about RSS.</description>
    <link>http://www.feedforall.com</link>
    <category domain="www.dmoz.com">Computers/Software/Internet/Site Management/Content Management</category>
    <copyright>Copyright 2004 NotePage, Inc.</copyright>
    <docs>http://blogs.law.harvard.edu/tech/rss</docs>
    <language>en-us</language>
    <lastBuildDate>Mon, 1 Nov 2004 13:17:17 -0500</lastBuildDate>
    <managingEditor>marketing@feedforall.com</managingEditor>
    <pubDate>Tue, 26 Oct 2004 14:06:44 -0500</pubDate>
    <webMaster>webmaster@feedforall.com</webMaster>
    <generator>FeedForAll Beta1 (0.0.1.8)</generator>
    <image>
      <url>http://www.feedforall.com/feedforall-temp.gif</url>
      <title>FeedForAll Sample Feed</title>
      <link>http://www.feedforall.com/industry-solutions.htm</link>
      <description>FeedForAll Sample Feed</description>
      <width>144</width>
      <height>117</height>
    </image>
    <item>
      <title>RSS Resources</title>
      <description>Be sure to take a look at some of our favorite RSS Resources&lt;br&gt;
&lt;a href=&quot;http://www.rss-specifications.com&quot;&gt;RSS Specifications&lt;/a&gt;&lt;br&gt;
&lt;a href=&quot;http://www.blog-connection.com&quot;&gt;Blog Connection&lt;/a&gt;&lt;br&gt;
&lt;br&gt;</description>
      <link>http://www.feedforall.com</link>
      <pubDate>Tue, 26 Oct 2004 14:01:01 -0500</pubDate>
    </item>
    <item>
      <title>Recommended Desktop Feed Reader Software</title>
      <description>&lt;b&gt;FeedDemon&lt;/b&gt; enables you to quickly read and gather information from hundreds of web sites - without having to visit them. Don&apos;t waste any more time checking your favorite web sites for updates. Instead, use FeedDemon and make them come to you. &lt;br&gt;
More &lt;a href=&quot;http://store.esellerate.net/a.asp?c=1_SKU5139890208_AFL403073819&quot;&gt;FeedDemon Information&lt;/a&gt;</description>
      <link>http://www.feedforall.com/feedforall-partners.htm</link>
      <pubDate>Tue, 26 Oct 2004 14:03:25 -0500</pubDate>
    </item>
    <item>
      <title>Recommended Web Based Feed Reader Software</title>
      <description>&lt;b&gt;FeedScout&lt;/b&gt; enables you to view RSS/ATOM/RDF feeds from different sites directly in Internet Explorer. You can even set your Home Page to show favorite feeds. Feed Scout is a plug-in for Internet Explorer, so you won&apos;t have to learn anything except for how to press 2 new buttons on Internet Explorer toolbar. &lt;br&gt;
More &lt;a href=&quot;http://www.bytescout.com/feedscout.html&quot;&gt;Information on FeedScout&lt;/a&gt;&lt;br&gt;
&lt;br&gt;
&lt;br&gt;
&lt;b&gt;SurfPack&lt;/b&gt; can feature search tools, horoscopes, current weather conditions, LiveJournal diaries, humor, web modules and other dynamically updated content. &lt;br&gt;
More &lt;a href=&quot;http://www.surfpack.com/&quot;&gt;Information on SurfPack&lt;/a&gt;&lt;br&gt;</description>
      <link>http://www.feedforall.com/feedforall-partners.htm</link>
      <pubDate>Tue, 26 Oct 2004 14:06:44 -0500</pubDate>
    </item>
  </channel>
</rss>`;
export const sampleRssFeedLinks = [
    'http://www.feedforall.com',
    'http://www.feedforall.com/industry-solutions.htm',
    'http://www.feedforall.com/feedforall-partners.htm',
];
// Source: https://www.ietf.org/rfc/rfc4287.txt
export const sampleAtomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">dive into mark</title>
  <subtitle type="html">
    A &lt;em&gt;lot&lt;/em&gt; of effort
    went into making this effortless
  </subtitle>
  <updated>2005-07-31T12:29:29Z</updated>
  <id>tag:example.org,2003:3</id>
  <link rel="alternate" type="text/html"
   hreflang="en" href="http://example.org/"/>
  <link rel="self" type="application/atom+xml"
   href="http://example.org/feed.atom"/>
  <rights>Copyright (c) 2003, Mark Pilgrim</rights>
  <generator uri="http://www.example.com/" version="1.0">
    Example Toolkit
  </generator>
  <entry>
    <title>Atom draft-07 snapshot</title>
    <link rel="alternate" type="text/html"
     href="http://example.org/2005/04/02/atom"/>
    <link rel="enclosure" type="audio/mpeg" length="1337"
     href="http://example.org/audio/ph34r_my_podcast.mp3"/>
    <id>tag:example.org,2003:3.2397</id>
    <updated>2005-07-31T12:29:29Z</updated>
    <published>2003-12-13T08:29:29-04:00</published>
    <author>
      <name>Mark Pilgrim</name>
      <uri>http://example.org/</uri>
      <email>f8dy@example.com</email>
    </author>
    <contributor>
      <name>Sam Ruby</name>
    </contributor>
    <contributor>
      <name>Joe Gregorio</name>
    </contributor>
    <content type="xhtml" xml:lang="en"
     xml:base="http://diveintomark.org/">
      <div xmlns="http://www.w3.org/1999/xhtml">
        <p><i>[Update: The Atom draft is finished.]</i></p>
      </div>
    </content>
  </entry>
</feed>`;
export const sampleAtomFeedLinks = [
    'http://example.org/',
    'http://example.org/feed.atom',
    'http://example.org/2005/04/02/atom',
    'http://example.org/audio/ph34r_my_podcast.mp3',
];
// Following format stated in https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap#text
export const sampleTxtSitemap = `https://www.example.com/file1.html
https://www.example.com/file2.html
https://www.example.com/file3.html`;
export const sampleTxtSitemapLinks = [
    'https://www.example.com/file1.html',
    'https://www.example.com/file2.html',
    'https://www.example.com/file3.html',
];
export const sampleNonStandardXmlSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<contents>
  <url>https://www.example.com/file1.html</url>
  <link href='https://www.example.com/file2.html' />
  <link>https://www.example.com/file3.html</link>
</contents>`;
export const sampleNonStandardXmlSitemapLinks = [
    'https://www.example.com/file1.html',
    'https://www.example.com/file2.html',
    'https://www.example.com/file3.html',
];
export const sampleRssSitemap2 = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">

  <title>Example Feed</title>
  <link href="http://example.org/"/>
  <updated>2003-12-13T18:30:02Z</updated>
  <author>
    <name>John Doe</name>
  </author>
  <id>urn:uuid:60a76c80-d399-11d9-b93C-0003939e0af6</id>

  <entry>
    <title>Atom-Powered Robots Run Amok</title>
    <link href="http://example.org/2003/12/13/atom03"/>
    <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
    <updated>2003-12-13T18:30:02Z</updated>
    <summary>Some text.</summary>
  </entry>

</feed>
`;
