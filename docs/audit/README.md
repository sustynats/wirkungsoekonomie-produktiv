# Konsistenzrevision der Wirkungsökonomie

Bestandsaufnahme und Prüfentwürfe vom 14. November 2026. Status `READY_FOR_AUTHOR_REVIEW` für das geprüfte Teilpaket. Die fachliche Einzelprüfung des Gesamtbestands läuft weiter.

## Inventur

- [Seiteninventar](woek-page-inventory.csv) mit 21.699 beobachteten URLs aus Sitemap, HTML-Verweisen einschließlich Canonicals und sichtbarem Browser-Suchindex. Enthalten sind Weiterleitungen, Aliasrouten und technische Endpunkte. 21.672 Abrufe lieferten HTTP 200, 26 HTTP 404 und einer HTTP 403. Ein Canonical-Alias ist keine eigenständige fachliche Prüfung.
- [Dokumentenmatrix](woek-document-inventory.csv) mit 1.170 verlinkten Download-URLs, 146 zusätzlich im Hauptrepository gefundenen Quelldateien und 13 Einträgen zu Projektoriginalen und Entwürfen. Die Stichprobe der Versionen und fachlichen Originale steht im Konfliktregister. Ein erreichbarer Download belegt keine inhaltliche Übereinstimmung. HTTP 403/405 und vergleichbare Status sind Zugriffs- oder Methodenbefunde.
- [Konfliktregister und Freigabefragen](woek-conflicts.yaml) mit führender Quelle und Entscheidungsstatus. `SCREENING_HIT` bezeichnet einen Texttreffer zur fachlichen Prüfung. Alte Ausgaben bekommen bei Bedarf einen Standhinweis oder ein Erratum.

## Fachliche Einzelprüfung

Die [Einzelbefunde zu Seiten](fachliche-einzelpruefung-seiten.csv) und [Einzelbefunde zu Dokumenten](fachliche-einzelpruefung-dokumente.csv) nennen URL, konkrete Fundstelle und Prüfergebnis. Die Tabellen lassen sich anhand der URL mit der Inventur verbinden. Die Glossarroute Folgencheck hat zwei Teilbefunde und wird in der Gesamtzeile nur einmal gezählt. Einträge ohne zugeordneten Befund behalten den Prüfstand `NOT_REVIEWED`. Das gilt auch für Inventareinträge zu Originalen ohne öffentliche URL, sofern ihre Sichtung nur in den vorbereitenden Auftragsunterlagen dokumentiert ist.

| Bereich | Einträge | Geprüft am angegebenen Ausschnitt | Abweichung | Offen im Ausschnitt |
| --- | ---: | ---: | ---: | ---: |
| Kernmodell, Steuern und Werkzeuge | 51 | 25 | 22 | 4 |
| Parlament, Radar und Wirkungsticker | 1.098 | 26 | 298 | 774 |
| UN-Ziele und SDG+ | 18 | 11 | 7 | 0 |
| WÖMS | 152 | 152 | 0 | 0 |
| Buch-Onlinefassung und Referenz | 112 | 84 | 5 | 23 |
| Masterregister | 621 | 619 | 2 | 0 |
| Akademie und Bibliothek | 59 | 52 | 6 | 1 |
| Institut | 15 | 7 | 2 | 6 |
| Glossar | 76 | 66 | 10 | 0 |
| Bibliotheksfassungen | 187 | 117 | 66 | 4 |
| **Seiten gesamt** | **2.388** | **1.158** | **418** | **812** |
| **Dokumente** | **31** | **26** | **2** | **3** |

`VERIFIED` bestätigt den in der Zeile bezeichneten Prüfgegenstand. `CONFLICT` beschreibt eine konkrete Abweichung im geprüften Ausgangsstand. Die Zeile hält fest, wenn der Entwurf die Abweichung bereits korrigiert. `OPEN` bezeichnet eine konkrete Lücke, etwa einen ausstehenden Primärquellenabgleich, einen nicht zugeordneten Textstand oder fehlenden Zugang. Der Browser-Zugriff und der Deployment-Stand stehen separat in der Inventur. Für **19.311 URLs und 1.298 Dokumentenzeilen** ist kein Einzelbefund in diesen Tabellen hinterlegt. Die URL-Zahl enthält auch Umleitungen, Aliasrouten und technische URLs.

- Für 621 WÖk-IDs wurden Anzeige, Regel und Status mit den entsprechenden Arbeitsmappenzeilen abgeglichen. Bei E-104 und E-106 fehlte die visuelle Kennzeichnung des offenen Prüfstatus. Die Schwellen und IDs stammen weiter aus den versionierten Registern.
- Bei 152 WÖMS-Karten wurden Zweck, Vorgehen, Ergebnis, Qualitätskriterien und Schutzmaßnahmen geprüft. Die 169 UN-Ziele auf den 17 Zielseiten wurden mit der Agenda 2030 abgeglichen. Die SDG+-Seite beschreibt den gesonderten WÖk-Stand. [Agenda 2030](https://sdgs.un.org/2030agenda)
- Bei allen 108 Buchkapiteln wurde die Zuordnung zum Word-Original hergestellt und der sichtbare Textabschnitt anhand der Absatzanker überprüft. Tabellen und externe Belege bleiben gesonderte Prüfgegenstände. Kapitel 92 und seine Quellenkarten erhalten einen datierten Standhinweis zur Vorsteuer und zum Tarifentwurf von 2025.
- Für 82 DNS-Detailseiten wurde die Zuordnung zu den amtlichen Daten und Metadaten geprüft. Beim Wirkungsticker umfasst der Abgleich Profilwerte, Rechenweg und Status im öffentlich verfügbaren Datenbestand. Bei 774 Portalbefunden fehlen weitere Primärbelege, vor allem zu einzelnen Ticker-Ereignissen. Die Befundzeilen benennen die geprüften und offenen Aussagen jeweils konkret.
- 76 Glossardefinitionen wurden am Begriffsleitfaden v1.8 und dem öffentlich verfügbaren Glossarexport abgeglichen. Für 53 Routen wurde zusätzlich die Live-Ansicht, für 23 der Repository-Stand herangezogen. Für Bibliotheksfassungen sind Herkunft und Versionskennzeichnung gesondert dokumentiert.
- Archivierte Publikationen behalten ihre Texte und PDFs. Das Kapitel 92, das Apfelbeispiel, ältere Kapitalsimulationen, der V40-Reader und drei Bibliothekseinträge erhalten Standhinweise oder einen präziseren Publikationsstatus. Normative Beschlüsse bleiben im Konfliktregister auf die Freigabe der Autorin bezogen.

Der Crawl folgte den öffentlichen Verweisen bis keine weiteren URLs in der Warteschlange waren. Er wertete HTML und Sitemaps aus und las den Browser-Index mit 19.113 Einträgen aus dem Manifest `f51dbe5f5e47b1ec`. Query- und Sprungmarkenvarianten wurden beim Crawl normalisiert. Abgemeldete Einstiege sind erfasst. App-interne dynamische Routen, private Daten und nicht verlinkte Bestände brauchen andere Quellen. 21.695 Seitenzeilen haben einen zugeordneten Repositorypfad, Pfadkandidaten oder nachgewiesenen Generator. Darunter sind 966 Routen aus dem lokal erzeugten Website-Artefakt und 464 fachlich neutrale paginierte Listen. Die Zuordnung belegt die Struktur des geprüften Checkouts. Live-Bytegleichheit und inhaltliche Einzelprüfung sind eigene Befunde. Bei 1.051 Dokumentenzeilen ist zusätzlich das Dateiformat am lokalen Quellpfad bestätigt.

## Produktionsstand

| Bereich | Repository und ermittelter Stand | Live |
| --- | --- | --- |
| Hauptwebsite | `sustynats/wirkungsoekonomie-produktiv`, Branch `main`, Commit `6430135e54ff167cd199e8bec6490dcf73dce1c3`. [Pages-Lauf](https://github.com/sustynats/wirkungsoekonomie-produktiv/actions/runs/43593353042) erfolgreich am 14.11.2026. | [Hauptwebsite](https://wirkungsoekonomie.de/) |
| Parlament | `sustynats/woek-parlament` veröffentlicht statisch. Pages-Deployment `666aca7b1478601643d2a1af121e5b9dd446c1ec`, 23.09.2026. Das Live-Artefakt nennt als Quellcommit `4227bca20b7c2bd0500e0ec1206710595d996966`. Anwendungsquellen und Regeln im Hauptprojekt unter `woek-parlament-app/`; Pfadzuordnungen dort sind Kandidaten. | [Parlament](https://parlament.wirkungsoekonomie.de/) |
| Akademie | `sustynats/woek-akademie-app`, `main` bei `ceff60743606bf02fb68b68618d23a79e27cf396`. Live-Commit offen. Öffentliche Studienseiten liegen teilweise auch im Hauptrepository. | [Akademie](https://akademie.wirkungsoekonomie.de/) |
| Institut | `sustynats/woek-institut-app`, `main` bei `81266ca36329f36e2fd071aa546255c8147f6aaf`. Live-Commit offen. | [Institut](https://institut.wirkungsoekonomie.de/) |
| Downloads | `sustynats/wirkungsoekonomie-medien` für neue Journal-PDFs. Historische Release-Links aus `sustynats/wirkungsoekonomie.de` bleiben zitierfähig. | [Bibliothek](https://wirkungsoekonomie.de/bibliothek/) |

Die Hauptwebsite ist statisch mit Generatoren und Templates. Die wichtigsten Quellbereiche sind `content/grundlagen`, `content/examples`, `content/woek-register`, `content/methods`, `content/news`, `content/academy`, `content/studienskripte`, `content/glossary`, `content/publications`, `source-assets`, die Site-/Portal-/Search-Generatoren in `scripts/` und die vorhandenen Rechner in `assets/js`. Öffentliche JSON-Manifeste, Suche und APIs liegen unter `api/`, `public/data/`, `assets/data/` und `assets/search/`. Die produktionsrelevante Pipeline steht in `.github/workflows/deploy.yml`. Die getrennten Akademie- und Instituts-Apps haben eigene Anwendungsrouten. Die jeweiligen Datenbankstände und ihre Zuordnung zum aktuellen Live-Release sind offen. `woek-knowledge` und `sdg-impact-matcher` wurden als verwandte Quellen ermittelt. Ihre Beteiligung am Live-Release ist offen.

## Referenzen und Entwürfe

Die Masterreferenz v3.0 vom 29.10.2026 wurde am 14.11.2026 direkt aus der kanonischen Oracle-Ablage verifiziert. Für Terminologie wurde der Begriffsleitfaden v1.8 identifiziert. Das WStG-3.0-Original und die Buchentwürfe wurden über die in der Referenz aufgeführten Prüfsummen identifiziert. WÖMM und WÖMS 2.0 wurden aus den verfügbaren Originalordnern im relevanten Themenbereich eingesehen. Die Konsolidierte Modellrevision v0.9 und die Architekturrevision vom 14.11.2026 wurden als Änderungsvorschläge gelesen. Der einschlägige Bestand enthält keine Freigabe dieser Vorschläge.

- [WStG-3.0-Änderungsvorschläge](revision/wstg-3-0-aenderungsentwurf.md)
- [Masterregister-Migrationsentwurf](revision/masterregister-migrationsentwurf.md)
- [Begriffs- und Errata-Entwürfe](revision/definitions-und-errata.md)
- [Stichproben zu Methoden und Portalen](methoden-und-portale.md)
- [Test- und Reviewprotokoll](teilpaket-pruefprotokoll.md)

Fachliche Einzelprüfung ausstehend insbesondere bei weiteren Rechnern, der fallbezogenen Methoden- und Indikatorzuordnung, Teilen des Akademie-Curriculums, politischen Fachakten, den Primärquellen weiterer Ticker-Beiträge und weiteren historischen Onlinefassungen. Die Freigabefragen in der YAML-Datei betreffen die noch offenen Entscheidungen dieses Teilpakets.
