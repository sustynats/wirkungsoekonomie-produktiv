import fs from 'node:fs';
import path from 'node:path';
import { writeRepositoryJson } from '../newsroom-store.mjs';

export const SDG_TRACKER_TITLE = 'Global SDG Impact Tracker';
export const SDG_TRACKER_DESCRIPTION =
  'Der Wirkungsticker verfolgt weltweit Maßnahmen zu den UN-Nachhaltigkeitszielen und ordnet ihre Folgen für Mensch, Planet und Demokratie ein.';
export const SDG_TRACKER_INTRO =
  'Der Wirkungsticker verfolgt weltweit Gesetze, Programme und Projekte zu den Nachhaltigkeitszielen der Vereinten Nationen. Die Ausgaben zeigen, was beschlossen, finanziert oder umgesetzt wurde und welche Veränderungen belegt sind.';
export const SDG_TRACKER_EVIDENCE =
  'Die Einordnung unterscheidet beobachtete Veränderungen, mögliche Folgen und offene Fragen für Mensch, Planet und Demokratie.';

export function applySdgAppDescription(artifactRoot) {
  const file = path.join(artifactRoot, 'wirkungsticker/manifest.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  writeRepositoryJson(file, {
    ...manifest,
    description: SDG_TRACKER_DESCRIPTION,
    categories: ['education'],
    shortcuts: [
      { name: 'SDG-Ausgaben', short_name: 'Ausgaben', url: '/wirkungsticker/sdg/' },
      { name: 'Redaktionelle Analysen', short_name: 'Analysen', url: '/wirkungsticker/analysen/' },
    ],
  });
}
