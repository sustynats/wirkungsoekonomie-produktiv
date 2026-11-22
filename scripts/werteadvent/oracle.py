#!/usr/bin/env python3
"""Deploy/status/export using existing private SSH config, never public credentials."""
import argparse,hashlib,json,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def ssh(script):
 c=json.loads((Path.home()/'.config/woek-reference/config.json').read_text());a=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2']
 if c.get('identity_file'):a+=['-i',str(Path(c['identity_file']).expanduser())]
 a+=[c['ssh_destination'],'sudo -n python3 -'];r=subprocess.run(a,input=script,text=True,capture_output=True,timeout=90)
 if r.returncode:raise RuntimeError(r.stderr[-1500:] or r.stdout[-1500:])
 return r.stdout
REMOTE='''import os,json,sqlite3,subprocess,sys,urllib.request,datetime,shutil,hashlib,pwd
from pathlib import Path
'''
def main():
 p=argparse.ArgumentParser();p.add_argument('action',choices=['deploy','status','stats']);p.add_argument('--include-reports',action='store_true');p.add_argument('--output',type=Path);a=p.parse_args()
 if a.action=='deploy':
  files={f:(ROOT/'ops/werteadvent'/f).read_text() for f in ['service.py','woek-werteadvent.service','woek-werteadvent-retention.service','woek-werteadvent-retention.timer']};release=hashlib.sha256(files['service.py'].encode()).hexdigest()[:16]
  code=REMOTE+'files='+repr(files)+'\nrelease='+repr(release)+'\n'+'''
base=Path('/opt/woek-werteadvent');target=base/'releases'/release
before=subprocess.run(['systemctl','is-active','caddy'],capture_output=True,text=True).stdout.strip()
if before!='active':raise RuntimeError('Existing proxy is not active')
available=int(next(x.split()[1] for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:')))
if available<160000 or shutil.disk_usage('/var/lib').free<1024**3:raise RuntimeError('Existing capacity insufficient')
try:pwd.getpwnam('woek-advent')
except KeyError:subprocess.run(['useradd','--system','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','woek-advent'],check=True)
target.mkdir(parents=True,exist_ok=True)
for name,content in files.items():(target/name).write_text(content)
subprocess.run(['python3','-m','py_compile',str(target/'service.py')],check=True)
old=(base/'current').resolve() if (base/'current').exists() else None
config=Path('/etc/caddy/Caddyfile');original=config.read_text();stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup=Path('/var/backups/woek-werteadvent')/stamp;backup.mkdir(parents=True,mode=0o700);(backup/'Caddyfile').write_text(original);os.chmod(backup/'Caddyfile',0o600)
unit=Path('/etc/systemd/system/woek-werteadvent.service');oldunit=unit.read_text() if unit.exists() else None
block='''+repr('''    # BEGIN WOEK WERTEADVENT ROUTE
    @woek_werteadvent path /api/werteadvent /api/werteadvent/*
    handle @woek_werteadvent {
        skip_log
        reverse_proxy 127.0.0.1:8792
    }
    # END WOEK WERTEADVENT ROUTE
''')+'''
if '# BEGIN WOEK WERTEADVENT ROUTE' not in original:
 marker='130.162.217.58.sslip.io {'
 if original.count(marker)!=1:raise RuntimeError('Unexpected existing proxy topology')
 updated=original.replace(marker,marker+'\\n'+block,1)
else:updated=original
try:
 unit.write_text(files['woek-werteadvent.service'])
 for name in ['woek-werteadvent-retention.service','woek-werteadvent-retention.timer']:(Path('/etc/systemd/system')/name).write_text(files[name])
 temp=base/'current-new'
 if temp.is_symlink():temp.unlink()
 temp.symlink_to(target);temp.replace(base/'current')
 subprocess.run(['systemctl','daemon-reload'],check=True)
 subprocess.run(['systemctl','enable','--now','woek-werteadvent.service'],check=True,stdout=subprocess.DEVNULL)
 subprocess.run(['systemctl','restart','woek-werteadvent.service'],check=True)
 subprocess.run(['systemctl','enable','--now','woek-werteadvent-retention.timer'],check=True,stdout=subprocess.DEVNULL)
 import time
 for attempt in range(20):
  try:
   health=json.load(urllib.request.urlopen('http://127.0.0.1:8792/api/werteadvent/health',timeout=2))
   if health['ok']:break
  except Exception:time.sleep(.2)
 else:raise RuntimeError('Local service did not become healthy')
 config.write_text(updated)
 subprocess.run(['caddy','validate','--config',str(config)],check=True,capture_output=True)
 subprocess.run(['systemctl','reload','caddy'],check=True)
 print(json.dumps({'ok':True,'release':release,'backup':str(backup),'mem_available_mb':round(available/1024),'service':health}))
except Exception:
 config.write_text(original)
 if oldunit is not None:unit.write_text(oldunit)
 if old:
  temp=base/'rollback-new';temp.symlink_to(old);temp.replace(base/'current')
  subprocess.run(['systemctl','daemon-reload']);subprocess.run(['systemctl','restart','woek-werteadvent.service'])
 else:subprocess.run(['systemctl','disable','--now','woek-werteadvent.service'],stdout=subprocess.DEVNULL)
 subprocess.run(['systemctl','reload','caddy'])
 raise
'''
 elif a.action=='status':code=REMOTE+"print(json.dumps({'health':json.load(urllib.request.urlopen('http://127.0.0.1:8792/api/werteadvent/health',timeout=3)),'service':subprocess.check_output(['systemctl','show','woek-werteadvent.service','-p','ActiveState','-p','MemoryCurrent','-p','MemoryMax','-p','CPUQuotaPerSecUSec'],text=True)}))"
 else:code=REMOTE+"print(subprocess.check_output(['runuser','-u','woek-advent','--','python3','/opt/woek-werteadvent/current/service.py','--export']+"+repr(['--include-reports'] if a.include_reports else [])+",text=True))"
 result=ssh(code)
 if a.output:a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(result);print('Saved private report to '+str(a.output))
 else:print(result)
if __name__=='__main__':main()
