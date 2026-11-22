import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class DiscordWebhookRejection extends Error {
  constructor(status) {
    super(`Discord rejected the webhook request (HTTP ${status}).`);
  }
}

function seenEntries(state) {
  if (!Array.isArray(state?.seen) || state.seen.some((guid) => typeof guid !== "string" || !guid)) {
    throw new Error("Invalid Discord publication state.");
  }
  return new Set(state.seen);
}

export async function publishRss({ items, state, save, send, report = console.log }) {
  if (state === null) {
    if (items.length === 0) throw new Error("Cannot initialise Discord publication from an empty feed.");
    const seen = [...new Set(items.map((item) => item.guid))];
    await save({ seen });
    report(`Initialised Discord publication state with ${seen.length} existing feed entries.`);
    return;
  }

  const seen = seenEntries(state);
  let published = 0;
  for (const item of [...items].reverse()) {
    if (seen.has(item.guid)) continue;

    // A failed reservation must stop before the webhook can deliver a message.
    await save({ seen: [...seen, item.guid] });
    try {
      await send(item);
    } catch (error) {
      if (error instanceof DiscordWebhookRejection) {
        await save({ seen: [...seen] });
        throw error;
      }
      throw new Error(`Discord delivery is unconfirmed for ${item.link}. Reservation kept to prevent a duplicate.`);
    }
    seen.add(item.guid);
    published++;
    report(`Published to Discord: ${item.title}`);
  }
  if (!published) report("No new feed entries to publish to Discord.");
}

function discordSender(webhookUrl, payload) {
  let url;
  try {
    url = new URL(webhookUrl);
  } catch {
    throw new Error("Invalid Discord webhook URL.");
  }
  if (!["discord.com", "discordapp.com"].includes(url.hostname) || url.protocol !== "https:" ||
      !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)) {
    throw new Error("Invalid Discord webhook URL.");
  }
  url.searchParams.set("wait", "true");
  return async (item) => {
    const body = JSON.stringify(payload(item));
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      throw new DiscordWebhookRejection(response.status);
    }
    if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}.`);
  };
}

export async function publishGitHubRss({ github, context, core, branch, path, loadFeed, payload, webhookUrl, stateOnly }) {
  const repo = context.repo;
  const { guardGitHubContentUpdate } = await import("../news/check-api-storage.mjs");
  let sha;
  let state = null;
  try {
    const { data } = await github.rest.repos.getContent({ ...repo, path, ref: branch });
    if (data.type !== "file" || data.encoding !== "base64" || !data.sha) {
      throw new Error("Discord publication state is not a readable file.");
    }
    state = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    seenEntries(state);
    sha = data.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const items = await loadFeed();
  if (state && (stateOnly || !webhookUrl)) {
    const seen = seenEntries(state);
    const pending = new Set(items.filter((item) => !seen.has(item.guid)).map((item) => item.guid));
    core.info(`Discord publication state loaded. ${pending.size} unpublished feed entries.`);
    if (!webhookUrl) core.notice("Discord webhook secret is missing in the production repository.");
    return;
  }

  const save = async (value) => {
    const content = Buffer.from(JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2) + "\n");
    await guardGitHubContentUpdate({
      file: path,
      content,
      readRepository: async () => (await github.rest.repos.get(repo)).data,
    });
    if (!sha) {
      try {
        await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
      } catch (error) {
        if (error.status !== 404) throw error;
        await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: context.sha });
      }
    }
    const { data } = await github.rest.repos.createOrUpdateFileContents({
      ...repo, path, branch, content: content.toString("base64"),
      message: "chore: record Discord RSS publication state",
      ...(sha ? { sha } : {}),
    });
    sha = data.content?.sha;
    if (!sha) throw new Error("GitHub did not confirm the Discord publication state write.");
  };

  await publishRss({ items, state, save, send: state ? discordSender(webhookUrl, payload) : undefined, report: core.info });
}

export async function runRssCli({ items, statePath, webhookUrl, payload, bootstrap, after }) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const candidates = after ? items.filter((item) => Date.parse(item.publishedAt) > after) : items;
  if (dryRun) {
    const state = await readLocalState(statePath);
    const seen = state ? seenEntries(state) : new Set();
    for (const item of [...candidates].reverse()) {
      if (args.includes("--all") || !seen.has(item.guid)) console.log(JSON.stringify(payload(item), null, 2));
    }
    return;
  }

  if (!statePath) throw new Error("Discord publication requires a state file.");
  if (args.includes("--all")) throw new Error("--all is only available for --dry-run previews.");
  await mkdir(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  const lock = await open(lockPath, "wx");
  try {
    const state = await readLocalState(statePath);
    if (!state && !bootstrap) throw new Error("Initialise the Discord publication state before sending.");
    const save = async (value) => {
      const temporary = `${statePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2) + "\n");
      await rename(temporary, statePath);
    };
    await publishRss({ items: state ? candidates : items, state, save, send: state ? discordSender(webhookUrl, payload) : undefined });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function readLocalState(statePath) {
  let state = null;
  if (statePath) {
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
      seenEntries(state);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return state;
}
