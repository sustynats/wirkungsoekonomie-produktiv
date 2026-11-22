import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These are supplemental access points, not replacements for historical citations.
// The source record and its original link remain byte-for-byte intact.
export const ACCESS_NOTES = Object.freeze([
  {
    id: 'st-abschiebungssicherung-2025',
    original: 'https://www.sachsen-anhalt.de/fileadmin/Bibliothek/Politik_und_Verwaltung/StK/STK/Startseite_pdf_Dokumente/Abschiebungssicherungsgesetz.pdf',
    destination: 'https://www.magdeburger-news.de/?c=20250320151742&cut=117&tag=mdn',
    label: 'Wiedergabe der Pressemitteilung bei Magdeburger News',
    versionNote: 'Veröffentlichung durch Dritte',
  },
  {
    id: 'imf-wp-2025-270',
    original: 'https://www.imf.org/en/-/media/files/publications/wp/2025/english/wpiea2025270-source-pdf.pdf',
    destination: 'https://www.imf.org/en/publications/wp/issues/2025/12/20/underpriced-and-overused-fossil-fuel-subsidies-data-2025-update-572729',
    label: 'IWF-Dokumentseite',
  },
  {
    id: 'landtag-st-geschaeftsordnung',
    original: 'https://www.landtag.sachsen-anhalt.de/fileadmin/Downloads/Verzeichnisse_Sitzordnung_Plenarsaal/Geschaeftsordnung_des_Landtags_von_Sachsen-Anhalt.pdf',
    destination: 'https://www.landtag.sachsen-anhalt.de/service/rechtsgrundlagen',
    label: 'Landtag: Rechtsgrundlagen',
    versionNote: 'Fassungsstand auf der Anbieterseite beachten',
  },
  {
    id: 'enisa-threat-landscape-2025',
    original: 'https://www.enisa.europa.eu/sites/default/files/2025-11/ENISA%20Threat%20Landscape%202025_0.pdf',
    destination: 'https://www.enisa.europa.eu/publications/enisa-threat-landscape-2025',
    label: 'ENISA-Dokumentseite',
    versionNote: 'Fassungsstand auf der Anbieterseite beachten',
  },
]);

const byOriginal = new Map(ACCESS_NOTES.map(note => [note.original, note]));
const markup = /<!--[\s\S]*?-->|<script\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/script\s*>|<style\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/style\s*>|<a\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/a\s*>/gi;

function noteMarkup(note) {
  const version = note.versionNote ? `; ${note.versionNote}` : '';
  const destination = note.destination.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<span data-source-access-note="${note.id}"> (ergänzender Quellenzugang: <a href="${destination}" target="_blank" rel="noopener noreferrer">${note.label}</a>${version})</span>`;
}

export function annotateSourceAccess(html) {
  let added = 0;
  const output = html.replace(markup, (token, offset, input) => {
    if (!/^<a\b/i.test(token)) return token;
    const opening = token.match(/^<a\b(?:"[^"]*"|'[^']*'|[^'">])*>/i)?.[0];
    if (!opening) return token;
    const href = opening.match(/(?:^|\s)href\s*=\s*(["'])(.*?)\1/i)?.[2];
    const note = byOriginal.get(href);
    if (!note || input.slice(offset + token.length).startsWith(`<span data-source-access-note="${note.id}">`)) return token;
    added += 1;
    return token + noteMarkup(note);
  });
  return { html: output, added };
}

export function annotateArtifact(root) {
  const resolved = path.resolve(root);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('SOURCE_ACCESS_ARTIFACT_NOT_DIRECTORY');
  let scanned = 0, changed = 0, added = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.html')) {
        scanned += 1;
        const input = fs.readFileSync(file, 'utf8');
        const result = annotateSourceAccess(input);
        if (result.added) {
          fs.writeFileSync(file, result.html);
          changed += 1;
          added += result.added;
        }
      }
    }
  }
  walk(resolved);
  return { scanned, changed, added };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('SOURCE_ACCESS_ARTIFACT_REQUIRED');
  console.log(`Supplemental source access: ${JSON.stringify(annotateArtifact(process.argv[2]))}`);
}
