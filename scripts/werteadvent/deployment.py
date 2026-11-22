#!/usr/bin/env python3
"""Add only campaign files to the verified live Pages artifact; retain rollback proof."""
import hashlib,json,os,re,shutil,subprocess,sys,tarfile
from pathlib import Path
REPO='sustynats/wirkungsoekonomie-produktiv'
ROOT=Path(__file__).resolve().parents[2]
CFG=json.loads((ROOT/'content/werteadvent/values.json').read_text())
ALLOWED_FILES=['werteadvent/index.html',CFG['hiddenRoute']+'/index.html','assets/css/werteadvent.css','assets/js/werteadvent.mjs','assets/js/werteadvent-participation.mjs']
def api(route):return json.loads(subprocess.check_output(['gh','api',f'repos/{REPO}/{route}']))
def active():
 for dep in api('deployments?environment=github-pages&per_page=100'):
  states=api(f"deployments/{dep['id']}/statuses")
  if states and states[0]['state']=='success':
   match=re.search(r'/actions/runs/(\d+)',states[0].get('log_url',''))
   if not match:raise RuntimeError('Active deployment has no source run')
   return {'deployment_id':dep['id'],'sha':dep['sha'],'run_id':int(match[1])}
 raise RuntimeError('No successful active deployment')
def inventory(folder):
 result={}
 for p in sorted(folder.rglob('*')):
  if p.is_symlink():raise RuntimeError('Symlink in public artifact')
  if p.is_file():result[str(p.relative_to(folder))]=hashlib.sha256(p.read_bytes()).hexdigest()
 return result

def main():
 mode=sys.argv[1];work=Path(os.environ.get('RUNNER_TEMP',ROOT/'output'))/'werteadvent-deployment';work.mkdir(parents=True,exist_ok=True)
 if mode=='baseline':
  baseline=active();run=api(f"actions/runs/{baseline['run_id']}")
  if run['conclusion']!='success' or run['head_sha']!=baseline['sha']:raise RuntimeError('Source deployment and successful run do not match')
  artifacts=[a for a in api(f"actions/runs/{baseline['run_id']}/artifacts")['artifacts'] if a['name']=='github-pages' and not a['expired']]
  if len(artifacts)!=1:raise RuntimeError('Ambiguous or expired baseline artifact')
  baseline['artifact_id']=artifacts[0]['id'];baseline['artifact_bytes']=artifacts[0]['size_in_bytes']
  (work/'baseline.json').write_text(json.dumps(baseline,indent=2)+'\n')
  download=work/'download';download.mkdir(exist_ok=True)
  subprocess.run(['gh','run','download',str(baseline['run_id']),'-R',REPO,'-n','github-pages','-D',str(download)],check=True)
  archive=download/'artifact.tar';baseline['archive_sha256']=hashlib.sha256(archive.read_bytes()).hexdigest();(work/'baseline.json').write_text(json.dumps(baseline,indent=2)+'\n')
  public=work/'public';public.mkdir(exist_ok=True)
  with tarfile.open(archive) as t:
   if any(m.issym() or m.islnk() or not(m.isfile() or m.isdir()) for m in t.getmembers()):raise RuntimeError('Unsupported baseline archive entries')
   t.extractall(public,filter='data')
  if (public/'CNAME').read_text().strip()!='wirkungsoekonomie.de' or not(public/'index.html').is_file():raise RuntimeError('Not the complete expected production website')
  print(json.dumps(baseline))
 elif mode=='integrate':
  public=work/'public';before=inventory(public)
  campaign=[str(p.relative_to(ROOT)) for p in sorted((ROOT/'assets/werteadvent-2026').rglob('*')) if p.is_file()]
  allowed=set(ALLOWED_FILES+campaign)
  if not all('/' in name and '..' not in Path(name).parts for name in allowed):raise RuntimeError('Unsafe path')
  for name in allowed:
   source=ROOT/name
   if source.is_symlink() or not source.is_file():raise RuntimeError('Missing source '+name)
   target=public/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
  after=inventory(public)
  changed={p for p in set(before)|set(after) if before.get(p)!=after.get(p)}
  if changed-allowed:raise RuntimeError('Unrelated production bytes changed')
  for name in ['assets/css/style.css','assets/fonts/inter-400.woff2','impressum.html','datenschutz.html']:
   if name not in after:raise RuntimeError('Missing existing dependency '+name)
  commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
  proof={'source_commit':commit,'baseline':json.loads((work/'baseline.json').read_text()),'unchanged_files':len(set(before)-changed),'changed_files':sorted(changed),'sha256':{p:after[p] for p in sorted(allowed)},'removed_files':sorted(set(before)-set(after))}
  if proof['removed_files']:raise RuntimeError('Production files were removed')
  (work/'unchanged-content.json').write_text(json.dumps(proof,indent=2)+'\n')
  subprocess.run(['node','scripts/werteadvent/check.mjs',f'--artifact={public}'],cwd=ROOT,check=True)
  print(f"Verified {proof['unchanged_files']} unchanged production files; {len(changed)} campaign files added/updated.")
 elif mode=='recheck':
  baseline=json.loads((work/'baseline.json').read_text());now=active()
  if any(now[k]!=baseline[k] for k in ['deployment_id','sha','run_id']):raise RuntimeError('Live baseline changed during preparation; rebuild against new active artifact')
  print('Active baseline unchanged; ready to publish the verified overlay.')
 else:raise RuntimeError('Unknown mode')
if __name__=='__main__':main()
