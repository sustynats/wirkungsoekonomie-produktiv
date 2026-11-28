import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { robotsDecision } from '../access-policy.mjs';
import { withRequestDeadline } from '../request-deadline.mjs';
import { MeasureRevisions, canonicalObservationJson, measureId } from './measure-revisions.mjs';

const sourceId = 'world-bank-projects';
const endpoint = 'https://search.worldbank.org/api/v3/projects';
const robots = 'https://search.worldbank.org/robots.txt';
const agent = 'WOek-Wirkungsticker';
const pageSize = 100;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const projectPattern = /^P\d{6}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const day = 86_400_000;

function calendarDate(value) {
  if (typeof value !== 'string' || !datePattern.test(value)) throw Error('SDG_PROJECT_DATE_INVALID');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw Error('SDG_PROJECT_DATE_INVALID');
  return value;
}

function privateDirectory(dir, { create = false } = {}) {
  if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) || fs.realpathSync(dir) !== dir) {
    throw Error('SDG_PROJECT_PRIVATE_DIRECTORY_REQUIRED');
  }
}

function readPrivateFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077) throw Error('SDG_PROJECT_PRIVATE_FILE_REQUIRED');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function writePrivateFile(file, body) {
  fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx', flush: true });
}

async function capture(fetcher, url, directory, name, accept, maxBytes) {
  return withRequestDeadline(async signal => {
    const response = await fetcher(url, { redirect: 'error', signal, headers: { 'User-Agent': agent, Accept: accept } });
    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw Error('SDG_PROJECT_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks);
    const digest = sha256(bytes);
    writePrivateFile(path.join(directory, name + '.raw'), bytes);
    writePrivateFile(path.join(directory, name + '.json'), JSON.stringify({
      url, status: response.status, bytes: size, sha256: digest,
      retry_after: response.headers.get('Retry-After'),
    }) + '\n');
    return { status: response.status, bytes, digest };
  }, { timeoutMs: 20_000, code: 'SDG_PROJECT_SOURCE_TIMEOUT' });
}

function projectObservation(key, row, start, end) {
  if (!projectPattern.test(key) || row?.id !== key || row.proj_id !== key ||
      row.status !== 'Active' || typeof row.project_name !== 'string' || !row.project_name.trim() ||
      row.project_name.length > 500 || /\p{C}/u.test(row.project_name) ||
      !Array.isArray(row.countrycode) || !row.countrycode.length ||
      !row.countrycode.every(code => typeof code === 'string' && /^[A-Z0-9]{2}$/.test(code)) ||
      typeof row.boardapprovaldate !== 'string' || !/^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(row.boardapprovaldate)) {
    throw Error('SDG_PROJECT_ROW_INVALID');
  }
  const approval = calendarDate(row.boardapprovaldate.slice(0, 10));
  if (approval < start || approval > end) throw Error('SDG_PROJECT_APPROVAL_FILTER_IGNORED');
  return {
    approval,
    value: {
      project_id: key,
      title: row.project_name.trim(),
      countries: [...new Set(row.countrycode)].sort(),
      documented_stage: 'World Bank Board approval',
      reported_project_status: row.status,
      planned_closing_date: row.closingdate ? calendarDate(row.closingdate) : null,
    },
  };
}

function parsePage(bytes, offset, seenTotal) {
  const value = JSON.parse(bytes);
  const total = Number(value?.total);
  if (typeof value?.total !== 'string' || !/^\d+$/.test(value.total) ||
      !Number.isSafeInteger(total) || (seenTotal !== null && seenTotal !== total) ||
      String(value.os) !== String(offset) || String(value.page) !== String(offset / pageSize + 1)) {
    throw Error('SDG_PROJECT_PAGINATION_CHANGED');
  }
  const projects = value.projects ?? {};
  if (typeof projects !== 'object' || Array.isArray(projects) ||
      Object.keys(projects).length !== Math.max(0, Math.min(pageSize, total - offset))) {
    throw Error('SDG_PROJECT_PAGE_INCOMPLETE');
  }
  return { total, projects: Object.entries(projects) };
}

function recordApproval(ledger, entry, observedAt) {
  const { key, captured, approval, value } = entry;
  const project = { authority: sourceId, reference: key };
  const timeline = ledger.timeline(measureId(project));
  const current = timeline.filter(row => row.domain === 'finance' && row.stage === 'approved').at(-1);
  if (current && current.discovered_at > observedAt) throw Error('SDG_PROJECT_CAPTURE_OUT_OF_ORDER');
  const unchanged = current?.event_at === approval && canonicalObservationJson(current.value) === canonicalObservationJson(value);
  return {
    case: project,
    event: { authority: sourceId, reference: 'board-approval', domain: 'finance', stage: 'approved' },
    event_at: approval,
    supersedes: unchanged ? current.supersedes : current?.revision_id ?? null,
    value,
    source: {
      registry_id: sourceId, reference: key, snapshot_sha256: captured,
      url: `https://projects.worldbank.org/en/projects-operations/project-detail/${key}`,
      published_at: null, discovered_at: observedAt,
    },
  };
}

export async function collectWorldBankApprovals({ privateRoot, source, now = new Date(), fetcher = fetch, wait = sleep }) {
  const intake = source?.sdg_intake;
  if (source?.source_id !== sourceId || source.api_url !== endpoint || intake?.robots_url !== robots ||
      intake.active !== true || intake.license !== 'CC BY 4.0' ||
      !Number.isSafeInteger(intake.revision_window_days) || intake.revision_window_days < 1) {
    throw Error('SDG_PROJECT_SOURCE_NOT_CLEARED');
  }
  const firstDate = calendarDate(intake.first_approval_date);
  const observedAt = now.toISOString();
  const end = observedAt.slice(0, 10);
  privateDirectory(privateRoot);
  const dir = path.join(privateRoot, 'intake', sourceId);
  privateDirectory(path.dirname(dir), { create: true });
  privateDirectory(dir, { create: true });
  const latestPath = path.join(dir, 'last-completed.json');
  const previous = fs.existsSync(latestPath) ? JSON.parse(readPrivateFile(latestPath)) : null;
  const recent = new Date(now.getTime() - intake.revision_window_days * day).toISOString().slice(0, 10);
  const priorEnd = previous ? calendarDate(previous.end) : firstDate;
  if (end < firstDate || priorEnd > end) throw Error('SDG_PROJECT_WINDOW_INVALID');
  const start = [firstDate, recent < priorEnd ? recent : priorEnd].sort().at(-1);
  const captureDir = fs.mkdtempSync(path.join(dir, 'capture-'));

  const checkedRobots = await capture(fetcher, robots, captureDir, 'robots', 'text/plain', 512_000);
  if (![200, 404, 410].includes(checkedRobots.status)) throw Error(`SDG_PROJECT_ROBOTS_${checkedRobots.status}`);
  const rules = checkedRobots.status === 200 ? checkedRobots.bytes.toString() : '';
  let total = null;
  const projects = new Map();
  const pageHashes = [];
  for (let offset = 0; total === null || offset < total; offset += pageSize) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      format: 'json', status_exact: 'Active', sort: 'boardapprovaldate', order: 'desc',
      rows: pageSize, os: offset, strdate: start, enddate: end,
      fl: 'id,project_name,countrycode,status,boardapprovaldate,closingdate',
    }).toString();
    const decision = robotsDecision(rules, url.href, agent);
    if (!decision.allowed) throw Error('SDG_PROJECT_ROBOTS_DISALLOWED');
    await wait(Math.max(500, decision.crawl_delay_seconds * 1000));
    const page = await capture(fetcher, url.href, captureDir, `page-${offset}`, 'application/json', 8 * 1024 * 1024);
    if (page.status !== 200) throw Error(`SDG_PROJECT_SOURCE_HTTP_${page.status}`);
    const parsed = parsePage(page.bytes, offset, total);
    total = parsed.total;
    for (const [key, row] of parsed.projects) {
      if (projects.has(key)) throw Error('SDG_PROJECT_PAGINATION_DUPLICATE');
      projects.set(key, { key, captured: page.digest, ...projectObservation(key, row, start, end) });
    }
    pageHashes.push(page.digest);
  }
  if (projects.size !== total) throw Error('SDG_PROJECT_SNAPSHOT_INCOMPLETE');

  const file = path.join(privateRoot, 'measures.sqlite');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077) throw Error('SDG_PROJECT_PRIVATE_FILE_REQUIRED');
  const ledger = new MeasureRevisions(file);
  let revisions;
  try {
    revisions = ledger.recordBatch([...projects.values()].map(entry => recordApproval(ledger, entry, observedAt)));
  } finally { ledger.close(); }
  const report = {
    source: sourceId, observed_at: observedAt, start, end, observations: projects.size,
    new_revisions: revisions.filter(row => row.newRevision).length,
    new_evidence_links: revisions.filter(row => row.newEvidence).length,
    snapshot: path.basename(captureDir), page_sha256: pageHashes,
  };
  const completed = JSON.stringify(report) + '\n';
  writePrivateFile(path.join(captureDir, 'completed.json'), completed);
  writePrivateFile(path.join(captureDir, 'latest.json'), completed);
  fs.renameSync(path.join(captureDir, 'latest.json'), latestPath);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [privateRoot] = process.argv.slice(2);
  if (!privateRoot || !path.isAbsolute(privateRoot)) throw Error('SDG_PROJECT_ROOT_REQUIRED');
  const registry = JSON.parse(fs.readFileSync(new URL('../../../content/news/sdg-source-registry.json', import.meta.url)));
  if (registry.schema_version !== 1) throw Error('SDG_PROJECT_REGISTRY_INVALID');
  console.log(JSON.stringify(await collectWorldBankApprovals({
    privateRoot, source: registry.sources.find(entry => entry.source_id === sourceId),
  })));
}
