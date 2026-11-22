#!/usr/bin/env python3
"""Consent-based aggregate counters and private self-reports; no visitor identifiers."""
import argparse,contextlib,datetime,hashlib,json,os,re,secrets,sqlite3,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit,urlunsplit
from zoneinfo import ZoneInfo
DB=Path(os.environ.get('WA_DATABASE','/var/lib/woek-werteadvent/campaign.sqlite3'))
ORIGINS={'https://wirkungsoekonomie.de','https://www.wirkungsoekonomie.de'}
PREFIX='/api/werteadvent';CONSENT='2026-11-19-v1'
ERASE_ON=datetime.datetime(2027,2,1,tzinfo=ZoneInfo('Europe/Berlin')).astimezone(datetime.timezone.utc)
PACKAGES={'icons-labelled','icons-unlabelled','icons-all','templates','concept','sharepic','qr'}
class Invalid(ValueError):pass
def now():return datetime.datetime.now(datetime.timezone.utc)
@contextlib.contextmanager
def connect(db=DB):
 c=sqlite3.connect(db,timeout=10);c.row_factory=sqlite3.Row;c.execute('PRAGMA secure_delete=ON')
 try:yield c;c.commit()
 except Exception:c.rollback();raise
 finally:c.close()
def initialize(db=DB):
 db.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 with connect(db) as c:
  c.execute('PRAGMA journal_mode=WAL')
  c.executescript('''CREATE TABLE IF NOT EXISTS counters(date TEXT,day INTEGER,event TEXT,resource TEXT,count INTEGER NOT NULL,PRIMARY KEY(date,day,event,resource));
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,day INTEGER NOT NULL,url TEXT NOT NULL,consent_version TEXT NOT NULL,created_utc TEXT NOT NULL,deletion_hash TEXT UNIQUE NOT NULL,UNIQUE(day,url));''')
 os.chmod(db,0o600)
def prune(db=DB,at=None):
 if (at or now())>=ERASE_ON:
  with connect(db) as c:c.execute('DELETE FROM reports')
  with connect(db) as c:c.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  with connect(db) as c:c.execute('VACUUM')
def day(v,zero=False):
 if type(v) is not int or not (0 if zero else 1)<=v<=24:raise Invalid('Ungültiger Tageswert.')
 return v
def event(p,db=DB,at=None):
 if set(p)-{'event','day','resource','consent'} or p.get('consent') is not True:raise Invalid('Freiwillige Zustimmung erforderlich.')
 e=p.get('event');d=day(p.get('day',0),True);r=p.get('resource','')
 if not isinstance(r,str) or len(r)>40:raise Invalid('Ungültiges Material.')
 if not ((e=='visit' and d==0 and not r) or (e=='value_open' and d>0 and not r) or(e=='download' and ((d>0 and r in {'icon-labelled','icon-unlabelled'})or(d==0 and r in PACKAGES)))):raise Invalid('Ungültiges Ereignis.')
 date=(at or now()).astimezone(ZoneInfo('Europe/Berlin')).date().isoformat()
 with connect(db) as c:c.execute('INSERT INTO counters VALUES(?,?,?,?,1) ON CONFLICT(date,day,event,resource) DO UPDATE SET count=count+1',(date,d,e,r))
 return {'ok':True}
def url(raw):
 if not isinstance(raw,str) or len(raw)>500:raise Invalid('Vollständigen TikTok-Beitragslink verwenden.')
 p=urlsplit(raw.strip())
 if p.scheme!='https' or p.netloc.lower() not in {'tiktok.com','www.tiktok.com'} or not re.fullmatch(r'/@[A-Za-z0-9_.]{1,32}/(?:video|photo)/[0-9]{6,24}/?',p.path):raise Invalid('Vollständigen TikTok-Video- oder Fotolink verwenden, keinen Kurz- oder Profillink.')
 return urlunsplit(('https','www.tiktok.com',p.path.rstrip('/'),'',''))
def report(p,db=DB,at=None):
 if set(p)-{'day','url','consent','consent_version','website'} or p.get('website'):raise Invalid('Ungültige Meldung.')
 at=at or now()
 if at>=ERASE_ON:raise Invalid('Meldezeitraum beendet.')
 d=day(p.get('day'));link=url(p.get('url'))
 if p.get('consent') is not True or p.get('consent_version')!=CONSENT:raise Invalid('Ausdrückliche Zustimmung erforderlich.')
 code=secrets.token_urlsafe(32)
 with connect(db) as c:
  if c.execute('SELECT COUNT(*) FROM reports').fetchone()[0]>=10000:raise Invalid('Die Meldestelle ist gerade ausgelastet. Bitte nutze den Kontakt zu Natalie.')
  try:c.execute('INSERT INTO reports VALUES(?,?,?,?,?,?)',(secrets.token_hex(12),d,link,CONSENT,at.isoformat(),hashlib.sha256(code.encode()).hexdigest()))
  except sqlite3.IntegrityError:return {'ok':True,'duplicate':True,'message':'Dieser Beitrag ist für diesen Wert bereits gemeldet und wird nicht erneut gezählt.'}
 return {'ok':True,'duplicate':False,'deletion_code':code,'message':'Danke! Dein Link wurde nur für die interne Auswertung gespeichert. Es erfolgt keine öffentliche Einbindung.'}
def delete(p,db=DB):
 code=p.get('deletion_code')
 if set(p)!={'deletion_code'} or not isinstance(code,str) or not re.fullmatch(r'[A-Za-z0-9_-]{40,64}',code):raise Invalid('Ungültiger Löschcode.')
 with connect(db) as c:c.execute('DELETE FROM reports WHERE deletion_hash=?',(hashlib.sha256(code.encode()).hexdigest(),))
 return {'ok':True,'message':'Die Meldung wurde gelöscht oder war bereits entfernt.'}
def export(db=DB,include_reports=False):
 prune(db)
 with connect(db) as c:
  result={'generated_utc':now().isoformat(),'counters':[dict(r) for r in c.execute('SELECT * FROM counters ORDER BY date,day,event,resource')],'reports_by_day':[dict(r) for r in c.execute('SELECT day,COUNT(*) AS submitted_links FROM reports GROUP BY day ORDER BY day')]}
  if include_reports:result['reports']=[dict(r) for r in c.execute('SELECT day,url,created_utc,consent_version FROM reports ORDER BY day,created_utc')]
 return result
class Handler(BaseHTTPRequestHandler):
 server_version='CampaignAPI';sys_version=''
 def log_message(self,*args):pass
 def setup(self):super().setup();self.connection.settimeout(8)
 def reply(self,status,data):
  b=json.dumps(data,ensure_ascii=False).encode();self.send_response(status)
  origin=self.headers.get('Origin')
  if origin in ORIGINS:self.send_header('Access-Control-Allow-Origin',origin)
  for k,v in {'Vary':'Origin','Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','Content-Length':str(len(b)),'X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow, noarchive'}.items():self.send_header(k,v)
  self.end_headers();self.wfile.write(b)
 def do_OPTIONS(self):
  if self.headers.get('Origin') not in ORIGINS or self.path not in {PREFIX+'/events',PREFIX+'/reports',PREFIX+'/reports/delete'}:return self.reply(403,{'ok':False})
  self.send_response(204)
  for k,v in {'Access-Control-Allow-Origin':self.headers['Origin'],'Vary':'Origin','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600','Cache-Control':'no-store','Content-Length':'0'}.items():self.send_header(k,v)
  self.end_headers()
 def do_GET(self):
  if self.path==PREFIX+'/health':return self.reply(200,{'ok':True,'service':'werteadvent-2026','reports_open':now()<ERASE_ON})
  return self.reply(404,{'ok':False})
 def do_POST(self):
  if self.headers.get('Origin') not in ORIGINS:return self.reply(403,{'ok':False})
  route={PREFIX+'/events':event,PREFIX+'/reports':report,PREFIX+'/reports/delete':delete}.get(self.path)
  if not route:return self.reply(404,{'ok':False})
  with self.server.budget_lock:
   minute=int(time.monotonic()//60)
   if self.server.minute!=minute:self.server.minute,self.server.requests=minute,0
   self.server.requests+=1
   if self.server.requests>600:return self.reply(429,{'ok':False,'message':'Bitte später erneut versuchen.'})
  try:
   size=int(self.headers.get('Content-Length','0'))
   if not 0<size<=2048:return self.reply(413,{'ok':False})
   if self.headers.get('Content-Type','').split(';')[0] not in {'application/json','text/plain'}:return self.reply(415,{'ok':False})
   p=json.loads(self.rfile.read(size))
   if not isinstance(p,dict):raise Invalid()
   return self.reply(200,route(p))
  except Invalid as e:return self.reply(400,{'ok':False,'message':str(e) or 'Bitte die Eingaben prüfen.'})
  except (ValueError,UnicodeError):return self.reply(400,{'ok':False,'message':'Bitte die Eingaben prüfen.'})
  except Exception:return self.reply(503,{'ok':False,'message':'Der Dienst ist gerade nicht verfügbar. Bitte später erneut versuchen.'})
def main():
 p=argparse.ArgumentParser();p.add_argument('--export',action='store_true');p.add_argument('--prune',action='store_true');p.add_argument('--include-reports',action='store_true');a=p.parse_args();initialize();prune()
 if a.prune:return
 if a.export:print(json.dumps(export(include_reports=a.include_reports),ensure_ascii=False));return
 server=ThreadingHTTPServer(('127.0.0.1',8792),Handler);server.daemon_threads=True;server.budget_lock=threading.Lock();server.minute=-1;server.requests=0
 def cleanup():
  while True:
   time.sleep(3600)
   try:prune()
   except Exception:pass
 threading.Thread(target=cleanup,daemon=True).start();server.serve_forever()
if __name__=='__main__':main()
