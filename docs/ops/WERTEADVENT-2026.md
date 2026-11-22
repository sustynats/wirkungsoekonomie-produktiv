# Werte-Advent 2026

Die statische Creator-Zentrale liegt unter `/werteadvent/` sowie unter
`/werte-advent-2026-creators-k7m4p9x2/`. Beide verwenden den bestehenden
Standalone-Dokumentrahmen, gemeinsame Website-Fonts und eine eigene Kampagnengestaltung.
Keine Aufnahme in Navigation, Footer, Suchindex, Verzeichnisse, Feeds oder Sitemaps.
Robots: `noindex, nofollow, noarchive`. GitHub Pages bietet keine konfigurierbaren
Response-Header; die Robots-Metadaten gelten für beide HTML-Routen.
Der lokale Interaktionsmarker schützt vor automatischer Analytics-Injektion.
Ein Direktlink ist kein Passwortschutz.

## Pflege

- `content/werteadvent/values.json`: 24 Werte und komplette Inspirationen, Kontakte,
  Release-URLs und bewusst deaktivierte Galerie. Die Profile hat die Initiatorin
  im Auftrag ausdrücklich angegeben; kein behauptetes Plattform-Verifizierungsabzeichen.
- `content/werteadvent/page.html`: redaktioneller Seiteninhalt.
- `scripts/werteadvent/build.mjs`: erzeugt beide Routen aus dem bestehenden Template.
- `scripts/werteadvent/prepare-assets.py`: reproduzierbare Vorschauen und ZIPs aus
  dem gelieferten Originalset; originale PNG/PDF-Bytes bleiben unverändert.
- `npm run build:werteadvent`, `npm run check:werteadvent`.
- Die Assets liegen im öffentlichen Medien-Release `werteadvent-2026-v2`.
  Bestehende Fassungen nicht überschreiben; Korrekturen bekommen neue Versionen.

Favoriten und Teilnahmestatus bleiben ausschließlich lokal. Die anschließend ausdrücklich beauftragte freiwillige Statistik und Beitragsmeldung sind davon getrennt umgesetzt; Betrieb, Datenminimierung und private Auswertung stehen in `ops/werteadvent/README.md`.
Keine fremden Videos/Creator automatisch übernehmen. Ein späterer Galerieeintrag
braucht eine ausdrückliche, zweckbezogene Freigabe zur öffentlichen Darstellung.

## Isolierte Veröffentlichung und Rückfall

`Publish unlisted Werte-Advent` benötigt den vollständigen geprüften Commit.
Das normale Deployment überspringt Commits mit `[werteadvent-release]`; diese
werden über den eigenen Workflow manuell veröffentlicht. Der Workflow sichert
das tatsächliche aktive Pages-Artefakt samt Herkunft und Prüfsumme, ergänzt nur
beide Routen und die Kampagnenassets und beweist, dass jede andere Datei bytegleich
bleibt. Navigation, Suche und Sitemaps werden zusätzlich auf Leaks geprüft.
Browser-, Datenschutz- und Größenprüfungen laufen vor dem Deploy. Unmittelbar
vor Veröffentlichung wird der aktive Ausgangsstand erneut verglichen.

Das Proof-Artefakt hält Ausgangs-Run, Artefakt-ID, Hash und Dateiinventar fest.
Für einen Rückfall kann das unveränderte `github-pages`-Artefakt dieses belegten
Ausgangs-Runs nach dem bestehenden geprüften Pages-Wiederveröffentlichungsverfahren
wieder ausgerollt werden. Kein vollständiger Neubau oder Vercel-Einsatz nötig.

## Prüfung der Ausgangsfassung

Chromium: 138 Funktionsprüfungen einschließlich 24 Anker, 48 Original-PNG-Downloads,
aller ZIP/PDF/Sharepic/QR-Downloads, Filter, Zwischenablage, manueller Kopierfallback,
Share-API-Aufruf, Linkfallback, lokaler Speicherung und Löschung. Darstellung auf
320, 390, 430, 768 und 1440 Pixeln ohne horizontales Überlaufen geprüft.
Der native Share-Dialog selbst ist betriebssystemabhängig; die Datenübergabe wurde geprüft.
Die Platzhalterfreiheit, Icon-Zuordnung, Metadaten und gemeinsame
Indexierbarkeitslogik sind ebenfalls geprüft. Keine empirische Kampagnenwirkung behauptet.

## Materialkorrektur v2

Die im Chat nachgereichten, für das Video korrigierten 24 beschrifteten PNGs wurden bytegleich übernommen. Die ursprünglichen 50 Quelldateien und das unveränderliche v1-Release bleiben unberührt. Das v2-Release führt die korrigierten Komplett- und Beschriftungspakete; Vorschauen und Einzel-PNGs verwenden dieselbe Fassung.
