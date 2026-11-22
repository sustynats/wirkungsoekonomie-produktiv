import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "discord.js";
import type { WebsiteFeedConfig } from "../src/config.js";
import { publicationKey, publishWebsiteFeedUpdates } from "../src/services/websiteFeedPublisher.js";

const folders: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true }); });
function setup(routes = [{ key: "journal", title: "Journal", url: "https://example.org/feed", channelId: "one" }], state: object = { version: 2, seenIds: [], lastCheckedAt: "2026-11-21" }) {
  const folder = mkdtempSync(join(tmpdir(), "feed-durability-")); folders.push(folder);
  const file = join(folder, "state.json"); writeFileSync(file, JSON.stringify(state));
  const channels = new Map<string, { send: ReturnType<typeof vi.fn>; isTextBased: () => boolean }>();
  for (const route of routes) channels.set(route.channelId, { send: vi.fn().mockResolvedValue({ id: "message" }), isTextBased: () => true });
  const client = { channels: { fetch: vi.fn(async (id: string) => channels.get(id)) } } as unknown as Client;
  const config: WebsiteFeedConfig = { enabled: true, stateFile: file, routes, pollMs: 300000, maxItemsPerPoll: 10, postExistingOnFirstRun: false };
  vi.stubGlobal("fetch", vi.fn(async () => new Response('<rss><channel><title>Journal</title><item><guid>changing-revision</guid><title>Article</title><link>https://wirkungsoekonomie.de/blog/example.html</link></item></channel></rss>')));
  return { file, client, config, channels, state: () => JSON.parse(readFileSync(file, "utf8")) };
}
describe("durable channel-bound publication", () => {
  it("persists a reservation before sending and a receipt before the next poll", async () => {
    const f = setup(); const channel = f.channels.get("one")!;
    channel.send.mockImplementation(async () => { expect(f.state().seenIds).toContain("one|https://wirkungsoekonomie.de/blog/example.html"); expect(Object.keys(f.state().pending)).toHaveLength(1); return {}; });
    await publishWebsiteFeedUpdates(f.client, f.config); await publishWebsiteFeedUpdates(f.client, f.config);
    expect(channel.send).toHaveBeenCalledTimes(1); expect(f.state().pending).toEqual({});
    expect(channel.send.mock.calls[0]?.[0]).toMatchObject({ enforceNonce: true, allowedMentions: { parse: [] } });
  });
  it("a rejected channel cannot replay successful announcements or block another channel", async () => {
    const routes = ["one", "two"].map(channelId => ({ key: channelId, title: channelId, channelId, url: `https://example.org/${channelId}` }));
    const f = setup(routes); f.channels.get("two")!.send.mockRejectedValue(Object.assign(new Error("permissions"), { status: 403 }));
    await publishWebsiteFeedUpdates(f.client, f.config); await publishWebsiteFeedUpdates(f.client, f.config);
    expect(f.channels.get("one")!.send).toHaveBeenCalledTimes(1); expect(f.channels.get("two")!.send).toHaveBeenCalledTimes(2);
    expect(f.state().seenIds).toEqual(["one|https://wirkungsoekonomie.de/blog/example.html"]);
  });
  it("retains ambiguous deliveries instead of repeating an accepted message", async () => {
    const f = setup(); f.channels.get("one")!.send.mockRejectedValue(new Error("connection closed after acceptance"));
    await expect(publishWebsiteFeedUpdates(f.client, f.config)).rejects.toThrow("connection closed");
    await publishWebsiteFeedUpdates(f.client, f.config);
    expect(f.channels.get("one")!.send).toHaveBeenCalledTimes(1); expect(Object.keys(f.state().pending)).toHaveLength(1);
  });
  it("retains more than 500 historical identities and uses URL plus channel rather than GUID", async () => {
    const seenIds = Array.from({ length: 600 }, (_, n) => `one|https://wirkungsoekonomie.de/blog/${n}.html`);
    seenIds.push(publicationKey({ channelId: "one", url: "https://wirkungsoekonomie.de/blog/example.html" }));
    const f = setup(undefined, { version: 2, seenIds, lastCheckedAt: "2026-11-21" });
    await publishWebsiteFeedUpdates(f.client, f.config);
    expect(f.channels.get("one")!.send).not.toHaveBeenCalled(); expect(f.state().seenIds).toHaveLength(601);
  });
  it("migrates the old state without replay and preserves every old identity", async () => {
    const f = setup(undefined, { seenIds: ["older-entry"], lastCheckedAt: "2026-07-23" });
    await publishWebsiteFeedUpdates(f.client, f.config);
    expect(f.channels.get("one")!.send).not.toHaveBeenCalled(); expect(f.state().legacySeenIds).toEqual(["older-entry"]); expect(f.state().version).toBe(2);
  });
  it("a corrupt state stops before sending", async () => {
    const f = setup(); writeFileSync(f.file, "invalid JSON");
    await expect(publishWebsiteFeedUpdates(f.client, f.config)).rejects.toThrow("cannot be verified"); expect(f.channels.get("one")!.send).not.toHaveBeenCalled();
  });
});
