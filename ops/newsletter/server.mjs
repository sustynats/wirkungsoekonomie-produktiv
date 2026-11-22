import { createServer } from 'node:http';

const base = '/api/woek-newsletter';
const origins = new Set([
  'https://wirkungsoekonomie.de', 'https://www.wirkungsoekonomie.de',
  'https://parlament.wirkungsoekonomie.de', 'https://130.162.217.58.sslip.io',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const token = /^[A-Za-z0-9_-]{43}$/;

function landing(action) {
  const confirm = action === 'confirm';
  const title = confirm ? 'Anmeldung bestätigen' : 'Wirkungsbrief abbestellen';
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer"><title>${title} | Wirkungsbrief</title><style>body{margin:0;background:#0b1020;color:#fffdf8;font:18px/1.6 system-ui}main{max-width:42rem;margin:10vh auto;padding:2rem}h1{font-family:Georgia,serif}button{font:inherit;background:#e7c98a;color:#0b1020;border:0;border-radius:.3rem;padding:1rem;cursor:pointer}button:disabled{opacity:.6}a{color:#e7c98a}.is-error{color:#ffca8a}</style><main data-woek-newsletter-landing="${action}"><p>Der Wirkungsbrief</p><h1>${title}</h1><p>${confirm ? 'Erst mit Ihrer Bestätigung wird die Anmeldung aktiv.' : 'Mit Ihrer Bestätigung wird Ihre Adresse aus dem Verteiler des Wirkungsbriefs gelöscht.'}</p><button data-woek-newsletter-landing-action>${title}</button><p data-woek-newsletter-landing-message role="status" aria-live="polite"></p><a href="https://wirkungsoekonomie.de/">Zur Wirkungsökonomie</a> · <a href="https://wirkungsoekonomie.de/datenschutz.html">Datenschutz</a> · <a href="https://wirkungsoekonomie.de/impressum.html">Impressum</a></main><script src="/woek-newsletter/client.js" defer></script></html>`;
}

export function createNewsletterServer(service) {
  const limits = new Map();
  function throttled(key, max, duration) {
    const now = Date.now();
    for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
    if (limits.size >= 5000 && !limits.has(key)) return true;
    const value = limits.get(key) || { count: 0, until: now + duration };
    value.count++;
    limits.set(key, value);
    return value.count > max;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname.startsWith('/woek-newsletter/')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      if (pathname === '/woek-newsletter/client.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(service.client);
      }
      const action = pathname === '/woek-newsletter/bestaetigen' ? 'confirm' : pathname === '/woek-newsletter/abmelden' ? 'unsubscribe' : null;
      if (action) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(landing(action)); }
    }
    if (![base, base + '/bestaetigen', base + '/abmelden'].includes(pathname)) return reply(404, { error: 'Nicht gefunden.' });
    const origin = req.headers.origin;
    if (!origins.has(origin)) return reply(403, { error: 'Ungültige Anfrage.' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204); return res.end();
    }
    if (req.method === 'GET' && pathname === base) return reply(200, { state: 'unknown', signup_available: service.ready() });
    if (req.method !== 'POST') return reply(405, { error: 'Ungültige Anfrage.' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(415, { error: 'Ungültiges Datenformat.' });
    // Only Caddy can reach the loopback listener; it overwrites X-Real-IP.
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
    if (throttled('ip:' + ip, 30, 60_000)) { res.setHeader('Retry-After', '60'); return reply(429, { error: 'Bitte warten Sie eine Minute und versuchen Sie es erneut.' }); }
    let body;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return reply(413, { error: 'Die Anfrage ist zu groß.' });
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return reply(400, { error: 'Bitte prüfen Sie Ihre Eingaben.' }); }
    try {
      if (pathname === base) {
        let input;
        try { input = service.parse(body); }
        catch { return reply(400, { error: 'Bitte prüfen Sie die E-Mail-Adresse und bestätigen Sie die Einwilligung.' }); }
        if (!service.ready()) return reply(503, { error: 'Die Anmeldung zum Wirkungsbrief ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.' });
        if (throttled('email:' + input.email.toLowerCase(), 1, 60_000)) { res.setHeader('Retry-After', '60'); return reply(429, { error: 'Bitte prüfen Sie Ihr Postfach und warten Sie eine Minute vor einem erneuten Versuch.' }); }
        const result = await service.subscribe(input);
        if (result.outcome === 'accepted' && result.delivery === 'not_sent' && !input.website.trim()) service.onDeliveryFailure();
        return reply(202, result);
      }
      if (!body || typeof body !== 'object' || typeof body.subscription !== 'string' || !uuid.test(body.subscription)
          || typeof body.token !== 'string' || !token.test(body.token)
          || (body.unsubscribe_token !== undefined && (typeof body.unsubscribe_token !== 'string' || !token.test(body.unsubscribe_token)))) return reply(400, { error: 'Dieser Link ist unvollständig oder ungültig.' });
      const result = pathname.endsWith('/bestaetigen')
        ? await service.confirm(body.subscription, body.token, body.unsubscribe_token)
        : await service.unsubscribe(body.subscription, body.token);
      // No cross-site recognition cookie or private session token in JSON.
      return reply(200, { outcome: result.outcome });
    } catch (error) {
      if (service.isConfirmationError(error)) return reply(400, { error: error.message });
      console.error('newsletter_request_failed');
      return reply(503, { error: 'Der Vorgang konnte nicht abgeschlossen werden. Bitte versuchen Sie es später erneut.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
