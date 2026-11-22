// Repository names can be reused; historical run identities cannot. The public
// replacement reads its own live runs normally and uses the reviewed, frozen
// evidence for the retired legacy repository. Missing evidence fails closed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const legacy='sustynats/wirkungsoekonomie.de';
const production='sustynats/wirkungsoekonomie-produktiv';
const generation='2026-11-22-privacy-reviewed';

export function retainedHistoryReader({root,gh=args=>execFileSync('gh',args,{encoding:'utf8',maxBuffer:24*1024*1024,timeout:20000})}) {
  const markerPath=path.join(root,'.github/public-source-baseline.json');
  if(!fs.existsSync(markerPath))return gh; // Existing nonreplacement checkouts.
  const marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));
  const certificatePath=path.join(root,'.github/retired-news-history.json');
  if(marker.generation!==generation || marker.repository!==production
    || !/^[a-f0-9]{64}$/.test(marker.retiredNewsHistorySha256 || '')
    || !fs.existsSync(certificatePath))throw Error('PAID_PREFLIGHT_RETIRED_HISTORY_MISSING');
  const raw=fs.readFileSync(certificatePath);
  if(createHash('sha256').update(raw).digest('hex')!==marker.retiredNewsHistorySha256)
    throw Error('PAID_PREFLIGHT_RETIRED_HISTORY_CHANGED');
  const certificate=JSON.parse(raw);
  if(certificate.schema!==1 || certificate.generation!==generation || certificate.repository!==production
    || certificate.replacement_repository_id!==1467786104
    || certificate.retired_legacy_repository_id!==1241055331
    || certificate.retired_legacy_private_archived!==true
    || certificate.retired_legacy_actions_disabled!==true
    || certificate.retired_production_repository_id!==1447217605
    || certificate.retired_production_private_archived!==true
    || !Number.isFinite(Date.parse(certificate.sealed_at))
    || !certificate.responses || Array.isArray(certificate.responses))
    throw Error('PAID_PREFLIGHT_RETIRED_HISTORY_UNVERIFIED');
  const current=JSON.parse(gh(['api','repos/'+production]));
  if(current.id!==certificate.replacement_repository_id || current.archived===true)
    throw Error('PAID_PREFLIGHT_REPLACEMENT_IDENTITY_CHANGED');
  return args=>{
    if(args[0]!=='api' || !String(args[1]).startsWith('repos/'+legacy+'/actions/'))return gh(args);
    if(args.length!==2 || !Object.hasOwn(certificate.responses,args[1]))
      throw Error('PAID_PREFLIGHT_RETIRED_READ_NOT_RETAINED');
    const result=certificate.responses[args[1]];
    // A retired repository has no running jobs. Do not turn an incomplete or
    // contradictory retained active-run response into a false all-clear.
    if(new URL('https://api.github.com/'+args[1]).searchParams.has('status')
      && (result.total_count!==0 || !Array.isArray(result.workflow_runs) || result.workflow_runs.length!==0))
      throw Error('PAID_PREFLIGHT_RETIRED_RUN_ACTIVE');
    return JSON.stringify(result);
  };
}
