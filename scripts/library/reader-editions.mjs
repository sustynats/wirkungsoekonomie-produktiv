export const LEGACY_GLOSSARY_READER_ROUTE = "/bibliothek/eintraege/leading-reference-bibliothek-woek-begriffsleitfaden-fuehrend-index-html/lesen/";

const detailConceptNotes = new Map([
  ["/bibliothek/eintraege/download-or-document-assets-downloads-16-woek-produkte-konsum-wirkungsumsatzsteuer-produktwirkun-2/lesen/", {
    text: "Die Lesefassung dokumentiert frühere und vorgeschlagene Steueroptionen. Der geltende Vorsteuerabzug richtet sich nach § 15 UStG. Für eine künftige Eingangs-Wirkungssteuer braucht es eine eigene gesetzliche Regelung.",
    href: "https://www.gesetze-im-internet.de/ustg_1980/__15.html",
    label: "§ 15 UStG lesen"
  }],
  ["/bibliothek/eintraege/download-or-document-assets-downloads-17-woek-produkte-konsum-produktscorecards-reverse-merit-or-2/lesen/", {
    text: "Bei fehlenden Nachweisen bleibt der Befund offen. Eine konservative Modellannahme braucht eine ausgewiesene Begründung und ersetzt keine Messung. Ein Engpass kann die Bewertung begrenzen. Für die Gesamtwirkung braucht es eine anwendbare Regel und ausreichende Belege.",
    href: "/bibliothek/woek-begriffsleitfaden-fuehrend/",
    label: "Begriffsleitfaden v1.8 lesen"
  }]
]);

export function readerEdition(route, detailSlug, registration) {
  const note = [...detailConceptNotes].find(([readerRoot]) => route.startsWith(readerRoot))?.[1];
  if (note) return { ...registration, note };
  if (!route.startsWith(LEGACY_GLOSSARY_READER_ROUTE)) return registration;
  return {
    detailSlug,
    title: "WÖk-Begriffsleitfaden v1.0 (Archivfassung)",
    status: "archiviert",
    historicalNotice: "Diese Lesefassung gibt den Begriffsleitfaden v1.0 vom 21. Mai 2026 wieder. Die führende Begriffsfassung ist v1.8 vom 1. Oktober 2026.",
    successorUrl: "bibliothek/woek-begriffsleitfaden-fuehrend/",
    successorLabel: "Führenden Begriffsleitfaden v1.8 lesen"
  };
}
