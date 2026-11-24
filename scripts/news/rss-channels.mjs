// Shared discovery metadata; the existing news builder supplies published items.
export const RSS_SITE = "https://wirkungsoekonomie.de";
export const RSS_CHANNELS = Object.freeze({
  news: Object.freeze({
    title: "Wirkungsticker - News",
    label: "News per RSS abonnieren",
    description: "Aktuelle Nachrichten aus Politik, Wirtschaft, Gesellschaft, Technik und weiteren Ressorts. Analysen und Nachbesprechungen haben einen eigenen RSS-Feed.",
    path: "/wirkungsticker/feed.xml",
    home: "/wirkungsticker/news/",
  }),
  analyses: Object.freeze({
    title: "Wirkungsticker - Analysen und Nachbesprechungen",
    label: "Analysen per RSS abonnieren",
    description: "Persönlich kuratierte Beiträge von Natalie Weber: Meinung & Analyse, Nachgehört, Nachgesehen und Buch & Wirkung.",
    path: "/wirkungsticker/analyse/feed.xml",
    home: "/wirkungsticker/analysen/",
  }),
});
export const SDG_RSS_CHANNEL = Object.freeze({
  title: "Global SDG Impact Tracker – Ausgaben",
  label: "SDG-Ausgaben per RSS abonnieren",
  description: "Die Ausgaben des Wirkungstickers zu Maßnahmen und belegten Veränderungen für die UN-Nachhaltigkeitsziele.",
  path: "/wirkungsticker/sdg/feed.xml",
  home: "/wirkungsticker/sdg/",
});
export const SDG_JSON_FEED_PATH = "/wirkungsticker/sdg/feed.json";
const NEWS_ARCHIVE_RSS_CHANNEL = Object.freeze({
  ...RSS_CHANNELS.news,
  title: "Wirkungsticker - Nachrichtenarchiv",
  description: "Archiv der bisher veröffentlichten allgemeinen Meldungen. SDG-Ausgaben und redaktionelle Beiträge haben eigene Feeds.",
});

export function tickerNewsRssChannel(sdgActive = false) {
  return sdgActive ? NEWS_ARCHIVE_RSS_CHANNEL : RSS_CHANNELS.news;
}

const xml = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));

export function rssDiscoveryLinks(channels = Object.values(RSS_CHANNELS)) {
  return channels.map(channel =>
    `<link rel="alternate" type="application/rss+xml" title="${xml(channel.title)}" href="${RSS_SITE}${channel.path}">`).join("\n  ");
}

export function sdgFeedDiscoveryLinks(canonical, { sdgActive = false } = {}) {
  if (!canonical.startsWith(`${RSS_SITE}${SDG_RSS_CHANNEL.home}`) && !(sdgActive && canonical === `${RSS_SITE}/wirkungsticker/`)) {
    return "";
  }
  return `${rssDiscoveryLinks([SDG_RSS_CHANNEL])}
  <link rel="alternate" type="application/feed+json" title="SDG-Ausgaben JSON-Feed" href="${RSS_SITE}${SDG_JSON_FEED_PATH}">
  `;
}

export function renderRssFeed(items, channel, { withBuildDate = true } = {}) {
  // An unrelated news run must not advance the analyses channel timestamp.
  const dates = items.flatMap(item => [Date.parse(item.updated_at), Date.parse(item.published_at)]).filter(Number.isFinite);
  const updated = withBuildDate ? `<lastBuildDate>${new Date(dates.length ? Math.max(...dates) : 0).toUTCString()}</lastBuildDate>` : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(channel.title)}</title><link>${RSS_SITE}${channel.home}</link><description>${xml(channel.description)}</description><language>de-de</language>${updated}<atom:link href="${RSS_SITE}${channel.path}" rel="self" type="application/rss+xml"/>${items.map(item => {
    // A correction updates the channel, not the item's first publication.
    const date = [item.published_at, item.updated_at].map(value => Date.parse(value)).find(Number.isFinite);
    return `<item><title>${xml(item.title)}</title><link>${xml(item.url)}</link><guid isPermaLink="true">${xml(item.url)}</guid>${date === undefined ? "" : `<pubDate>${new Date(date).toUTCString()}</pubDate>`}<description>${xml(item.summary)}</description></item>`;
  }).join("")}</channel></rss>`;
}
