import { randomUUID } from 'node:crypto';

const LEGACY_REPOSITORY = 'sustynats/wirkungsoekonomie.de';
const NEW_REPOSITORY = 'sustynats/wirkungsoekonomie-produktiv';
const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

export function resolveAdminRepository(env = process.env) {
  const configured = env.WOEK_NEWS_REPOSITORY || null;
  const runtime = env.GITHUB_ACTIONS === 'true' ? env.GITHUB_REPOSITORY : null;
  if (env.GITHUB_ACTIONS === 'true' && !runtime) throw Error('BRIDGE_RUNTIME_REPOSITORY_REQUIRED');
  if (configured && runtime && configured !== runtime) throw Error('BRIDGE_RUNTIME_REPOSITORY_MISMATCH');
  const chosen = configured || runtime || NEW_REPOSITORY;
  if (chosen === LEGACY_REPOSITORY) throw Error('BRIDGE_REPOSITORY_RETIRED');
  if (![LEGACY_REPOSITORY, NEW_REPOSITORY].includes(chosen)) throw Error('BRIDGE_REPOSITORY_INVALID');
  return chosen;
}

export async function runAdminAction(action, {gh, watch, log = console.log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), repo = NEW_REPOSITORY}) {
  if (!['DISCOVERY_NOW','IMPORT_NOW','SERVER_CYCLE_NOW'].includes(action)) throw Error('BRIDGE_ADMIN_ACTION_INVALID');
  if (repo === LEGACY_REPOSITORY) throw Error('BRIDGE_REPOSITORY_RETIRED');
  if (![LEGACY_REPOSITORY, NEW_REPOSITORY].includes(repo)) throw Error('BRIDGE_REPOSITORY_INVALID');
  const workflows = action === 'DISCOVERY_NOW' ? ['wirkungsticker-discovery.yml'] : action === 'IMPORT_NOW' ? ['wirkungsticker.yml'] : ['wirkungsticker-discovery.yml','wirkungsticker.yml'];
  for (const workflow of workflows) {
    // Only production accepts dispatches after the original repositories are
    // retired. The worker separately verifies retained historical spending
    // before any provider request; this dispatcher never performs paid work.
    const checkRepositories = [NEW_REPOSITORY];
    const checkWorkflows = ['wirkungsticker-discovery.yml', 'wirkungsticker.yml'];
    for (const checkRepo of checkRepositories) {
      for (const checkWorkflow of checkWorkflows) {
        // Filtering each active state avoids mistaking a full page of older
        // completed runs for an uninspectable active queue.
        const statuses = repo === NEW_REPOSITORY ? [...ACTIVE] : [null];
        for (const status of statuses) {
          const limit = status ? 100 : 30;
          const args = ['run','list','--repo',checkRepo,'--workflow',checkWorkflow,'--limit',String(limit),'--json','databaseId,status,url'];
          if (status) args.push('--status', status);
          const runs = JSON.parse(await gh(args));
          if (!Array.isArray(runs) || (status && runs.length >= limit)) throw Error('BRIDGE_RUN_LIST_UNCERTAIN');
          if (status && runs.some(run => run.status !== status)) throw Error('BRIDGE_RUN_STATUS_UNCERTAIN');
          const active = runs.find(r => ACTIVE.has(r.status));
          if (active) {
            const result = {status:'RUN_ALREADY_ACTIVE',action,workflow:checkWorkflow,url:active.url};
            log(JSON.stringify(result));
            return result; // Expected contention: no second writer and no failure mail.
          }
        }
      }
    }
    const request = `bridge-${action.toLowerCase()}-${randomUUID()}`;
    await gh(['workflow','run',workflow,'--repo',repo,'--ref','main','-f',`request_id=${request}`]);
    let run;
    for (let attempt=0;attempt<24&&!run;attempt++) {
      if (attempt) await sleep(5000);
      run = JSON.parse(await gh(['run','list','--repo',repo,'--workflow',workflow,'--limit','30','--json','databaseId,displayTitle,url'])).find(r=>r.displayTitle===request);
    }
    if (!run) throw Error(`BRIDGE_DISPATCH_LOOKUP_PENDING:${request}`);
    log(run.url);
    await watch(run.databaseId, repo); // Actual worker failures remain failures.
  }
  return {status:'COMPLETED',action};
}
