/**
 * RSS Feed Generator Module
 * Generates RSS 2.0 feed from extracted quotes
 */

/**
 * Generate RSS 2.0 feed XML from quotes
 * @param {Array} quotes - Array of quote objects
 * @param {Object} options - Feed options
 * @returns {string} - RSS XML string
 */
export function generateRssFeed(quotes, options = {}) {
    const {
        title = 'YouTube Quote Extractor',
        description = 'Notable quotes extracted from YouTube videos',
        link = 'https://example.com/quotes',
        language = 'en-us',
        maxItems = 100
    } = options;

    // Sort quotes by extraction date (newest first)
    const sortedQuotes = [...quotes]
        .sort((a, b) => new Date(b.extractedAt) - new Date(a.extractedAt))
        .slice(0, maxItems);

    const lastBuildDate = sortedQuotes.length > 0
        ? new Date(sortedQuotes[0].extractedAt).toUTCString()
        : new Date().toUTCString();

    const items = sortedQuotes.map(quote => generateRssItem(quote)).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(title)}</title>
    <description>${escapeXml(description)}</description>
    <link>${escapeXml(link)}</link>
    <language>${language}</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <generator>YouTube Quote Extractor</generator>
    <atom:link href="${escapeXml(link)}/rss.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
}

/**
 * Generate a single RSS item from a quote
 * @param {Object} quote - Quote object
 * @returns {string} - RSS item XML
 */
function generateRssItem(quote) {
    const videoUrl = `https://www.youtube.com/watch?v=${quote.videoId}`;
    const pubDate = new Date(quote.extractedAt).toUTCString();

    // Create a unique GUID for the quote
    const guid = `quote-${quote.id || `${quote.videoId}-${hashString(quote.text)}`}`;

    // Build description with context and source info
    let description = `<p>"${escapeXml(quote.text)}"</p>`;

    if (quote.context) {
        description += `<p><em>Context: ${escapeXml(quote.context)}</em></p>`;
    }

    description += `<p>From: <a href="${videoUrl}">${escapeXml(quote.videoTitle)}</a></p>`;
    description += `<p>Channel: ${escapeXml(quote.channelTitle)}</p>`;

    // Content-encoded version with full HTML
    const contentEncoded = `<![CDATA[
<blockquote style="font-style: italic; border-left: 3px solid #3b82f6; padding-left: 15px; margin: 10px 0;">
  "${escapeXml(quote.text)}"
</blockquote>
${quote.context ? `<p style="color: #666;"><em>Context: ${escapeXml(quote.context)}</em></p>` : ''}
<p><strong>Video:</strong> <a href="${videoUrl}">${escapeXml(quote.videoTitle)}</a></p>
<p><strong>Channel:</strong> ${escapeXml(quote.channelTitle)}</p>
]]>`;

    return `    <item>
      <title>${escapeXml(truncateText(quote.text, 100))} - ${escapeXml(quote.channelTitle)}</title>
      <link>${videoUrl}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(description)}</description>
      <content:encoded>${contentEncoded}</content:encoded>
      <author>${escapeXml(quote.channelTitle)}</author>
    </item>`;
}

/**
 * Escape special XML characters
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
function escapeXml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Truncate text to a maximum length
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} - Truncated text
 */
function truncateText(text, maxLength) {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
}

/**
 * Simple string hash for generating unique IDs
 * @param {string} str - String to hash
 * @returns {string} - Hash string
 */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
}

/**
 * Generate OPML file for RSS feed subscriptions
 * @param {Array} feeds - Array of feed objects with title and xmlUrl
 * @returns {string} - OPML XML string
 */
export function generateOpml(feeds, title = 'YouTube Quote Feeds') {
    const outlines = feeds.map(feed =>
        `      <outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(feed.xmlUrl)}"/>`
    ).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head>
    <title>${escapeXml(title)}</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
    <outline text="YouTube Quotes" title="YouTube Quotes">
${outlines}
    </outline>
  </body>
</opml>`;
}

/**
 * Download RSS feed as a file
 * @param {string} rssContent - RSS XML content
 * @param {string} filename - Filename for download
 */
export function downloadRssFeed(rssContent, filename = 'quotes-rss.xml') {
    const blob = new Blob([rssContent], { type: 'application/rss+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export default {
    generateRssFeed,
    generateOpml,
    downloadRssFeed
};
