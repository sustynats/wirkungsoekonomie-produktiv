#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runRssCli } from "./rss-publication.mjs";

const FEED_PATH = "feeds/journal.xml";
const DEFAULT_FEED_URL = "https://wirkungsoekonomie.de/feeds/journal.xml";
const MAX_DESCRIPTION_LENGTH = 350;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runRssCli({
    items: await loadFeed(),
    statePath: process.env.JOURNAL_DISCORD_STATE_PATH,
    webhookUrl: process.env.DISCORD_JOURNAL_WEBHOOK_URL,
    payload: webhookPayload,
    bootstrap: process.env.JOURNAL_DISCORD_BOOTSTRAP === "1",
    after: parseAfter(process.argv.slice(2)),
  });
}

export async function loadFeed(url = process.env.JOURNAL_FEED_URL ?? DEFAULT_FEED_URL) {
  if (process.env.JOURNAL_FEED_FILE === "1") {
    try {
      return parseRss(await readFile(FEED_PATH, "utf8"));
    } catch {
      throw new Error(`Could not read local journal feed: ${FEED_PATH}`);
    }
  }
  const response = await fetch(url, { headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
  if (!response.ok) throw new Error(`Could not load journal feed: ${response.status} ${url}`);
  return parseRss(await response.text());
}

function parseRss(xml) {
  return Array.from(xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi))
    .map((match) => parseItem(match[1]))
    .filter((item) => item.guid && item.title && item.link);
}

function parseItem(block) {
  const value = (name) => decodeXml((block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, ""));
  const categories = Array.from(block.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi))
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean);
  const image = block.match(/<media:(?:content|thumbnail)\b[^>]*\burl=["']([^"']+)["']/i)?.[1];
  const link = value("link");
  return {
    title: value("title"),
    link,
    guid: value("guid") || link,
    description: value("description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    publishedAt: value("pubDate"),
    categories,
    image
  };
}

export function webhookPayload(item) {
  const categories = item.categories.slice(0, 6).map((value) => `• ${value}`).join("\n");
  const embed = {
    title: item.title,
    url: item.link,
    description: truncate(item.description, MAX_DESCRIPTION_LENGTH),
    color: 0x176b5b,
    footer: { text: `Journal der Wirkungsökonomie • ${formatDate(item.publishedAt)}` },
    fields: [{ name: "Auf der Website lesen", value: item.link }]
  };
  const timestamp = new Date(item.publishedAt);
  if (!Number.isNaN(timestamp.getTime())) embed.timestamp = timestamp.toISOString();
  if (categories) embed.fields.unshift({ name: "Schlagworte", value: categories });
  if (item.image) embed.thumbnail = { url: item.image };

  return {
    username: "WÖk-Wirkungscheck",
    allowed_mentions: { parse: [] },
    embeds: [embed]
  };
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Journal" : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(date);
}

function truncate(value, length) {
  return value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`;
}

function parseAfter(values) {
  const input = values.find((value) => value.startsWith("--after="));
  if (!input) return null;
  const timestamp = Date.parse(input.slice("--after=".length));
  if (Number.isNaN(timestamp)) throw new Error("--after requires an ISO date, for example --after=2026-07-10T18:18:00Z");
  return timestamp;
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
