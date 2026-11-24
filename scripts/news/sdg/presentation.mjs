import fs from 'node:fs';
import path from 'node:path';
import { writeRepositoryJson } from '../newsroom-store.mjs';

export const SDG_TRACKER_TITLE = 'Global SDG Impact Tracker';
export const SDG_TRACKER_DESCRIPTION =
  'Der Wirkungsticker dokumentiert weltweit Maßnahmen, Fortschritte und Rückschritte zu den Nachhaltigkeitszielen und ordnet ihre Folgen für Mensch, Planet und Demokratie ein.';
export const SDG_TRACKER_INTRO =
  'Der Wirkungsticker verfolgt weltweit, was sich bei der Umsetzung der UN-Nachhaltigkeitsziele verändert. Die Ausgaben dokumentieren Beschlüsse, Finanzierung und Umsetzung von Gesetzen, Programmen und Projekten. Sie zeigen belegte Fortschritte und Rückschritte und benennen offene Fragen.';
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
