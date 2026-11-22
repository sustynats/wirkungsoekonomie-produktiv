import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERIFICATION_ROUTE = "w/natalie-weber/anfrage-bestaetigen/index.html";
const SCRIPT_PATH = "assets/js/telephone-booking-verify.js";
const STYLE_PATH = "assets/css/telephone-booking-verify.css";

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("BOOKING_VERIFICATION_TEMPLATE_CONTRACT_CHANGED");
  return source.replace(before, after);
}

// A token-entry service page, built from the existing booking template and CSS.
// It deliberately has no discovery/navigation, newsletter, analytics or OAuth.
export function buildPhoneVerificationPage(root) {
  const booking = path.join(root, "ops/telephone-booking");
  let html = fs.readFileSync(path.join(booking, "templates/verify.html"), "utf8");
  html = replaceOnce(html,
    '<meta name="robots" content="noindex,nofollow">',
    '<meta name="robots" content="noindex, nofollow, noarchive"><meta name="woek-booking-verification">');
  html = replaceOnce(html,
    '  <link rel="stylesheet" href="/api/telephone-booking/manage.css">\n  <script src="/api/telephone-booking/verify.js" defer></script>',
    '  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src https://wirkungsoekonomie.de/assets/js/telephone-booking-verify.js; style-src https://wirkungsoekonomie.de/assets/css/telephone-booking-verify.css; connect-src https://130.162.217.58.sslip.io; base-uri \'none\'; form-action \'none\'">\n' +
    `  <script src="/${SCRIPT_PATH}"></script>\n  <link rel="stylesheet" href="/${STYLE_PATH}">`);
  html = replaceOnce(html, '  <button id="discord" hidden>Bei Discord anmelden und Account prüfen</button>\n', "");
  html = replaceOnce(html, "{{ profile_url }}", "/w/natalie-weber/#gespraech");
  html = replaceOnce(html, "</main></body></html>", '</main><footer><p><a href="/datenschutz.html">Datenschutz</a> · <a href="/w/natalie-weber/">Profil und Kontakt</a></p></footer></body></html>');
  const files = [
    [VERIFICATION_ROUTE, html],
    [SCRIPT_PATH, fs.readFileSync(path.join(booking, "static/phone-verify.js"))],
    [STYLE_PATH, fs.readFileSync(path.join(booking, "static/manage.css"))]
  ];
  for (const [relative, content] of files) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  return files.map(([relative]) => relative);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPhoneVerificationPage(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
}
