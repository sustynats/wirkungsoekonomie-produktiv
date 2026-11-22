#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runRssCli } from "./rss-publication.mjs";

const FEED_PATH = "feeds/neuigkeiten.xml";
const DEFAULT_FEED_URL = "https://wirkungsoekonomie.de/feeds/neuigkeiten.xml";
const MAX_DESCRIPTION_LENGTH = 500;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runRssCli({
    items: await loadFeed(),
    statePath: process.env.SITE_UPDATES_DISCORD_STATE_PATH,
    webhookUrl: process.env.DISCORD_WEBSITE_UPDATES_WEBHOOK_URL,
    payload: webhookPayload,
    bootstrap: process.env.SITE_UPDATES_DISCORD_BOOTSTRAP === "1",
  });
}

export async function loadFeed(url = process.env.SITE_UPDATES_FEED_URL ?? DEFAULT_FEED_URL) {
  if (process.env.SITE_UPDATES_FEED_FILE === "1") return parseRss(await readFile(FEED_PATH, "utf8"));
  const response = await fetch(url, { headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
  if (!response.ok) throw new Error(`Could not load website updates feed: ${response.status} ${url}`);
  return parseRss(await response.text());
}

function parseRss(xml) {
  return Array.from(xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)).map((match) => {
    const block = match[1];
    const value = (name) => decodeXml((block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, ""));
    const link = value("link");
    return { title: value("title"), link, guid: value("guid") || link, description: value("description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), publishedAt: value("pubDate"), category: value("category") };
  }).filter((item) => item.guid && item.title && item.link);
}

export function webhookPayload(item) {
  const embed = {
    title: item.title, url: item.link, description: truncate(item.description, MAX_DESCRIPTION_LENGTH), color: 0xc9a64b,
    footer: { text: `${item.category || "Wirkungsökonomie"} • ${formatDate(item.publishedAt)}` },
    fields: [{ name: "Mehr erfahren", value: item.link }],
  };
  const timestamp = new Date(item.publishedAt);
  if (!Number.isNaN(timestamp.getTime())) embed.timestamp = timestamp.toISOString();
  return { username: "WÖk-Website-Updates", allowed_mentions: { parse: [] }, embeds: [embed] };
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Neuigkeit" : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(date);
}
function truncate(value, length) { return value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`; }
function decodeXml(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").trim();
}
