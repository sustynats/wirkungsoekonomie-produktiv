# Prüfnotizen zu Methoden und Portalen

Stichproben zum Live-Stand vom 14. November 2026. Die Prüfung der jeweiligen Unterseiten und Fachakten bleibt in der Inventur sichtbar.

| Geprüfter Einstieg | Befund | Nächste konkrete Prüfung |
| --- | --- | --- |
| [WÖMM 2.0](https://wirkungsoekonomie.de/bibliothek/eintraege/woemm-2-0/) | Sechs gekoppelte Elemente, zwölf Managementfelder und 17 Managementfunktionen stimmen mit dem eingesehenen Original überein. | Wirkungspass als optionale Übergabe an das Wirkungsrad fachlich freigeben. |
| [WÖMS 2.0](https://wirkungsoekonomie.de/bibliothek/eintraege/woems-2-0/) | Alle 152 Methoden-IDs und Titel stimmen mit dem Original überein. Bei den 84 Grundmethoden stimmen 82 Kernoutputs wörtlich überein. D08 und D09 sind quellenbezogen erläutert. | Weitere Detailfelder und die Anwendung der Methoden fallbezogen prüfen. |
| [T-SROI](https://wirkungsoekonomie.de/werkzeuge/t-sroi/) | Der Einstieg zeigt den Transformationsnutzen als eigenen belegten Strom. Der aktuelle Rechenstandard v1.1 nennt Investitionen, Programme, Infrastruktur und Portfolios. | Verweise historischer Produkt- und Steuerseiten im jeweiligen Kontext prüfen. |
| [Reverse Merit Order](https://wirkungsoekonomie.de/werkzeuge/reverse-merit-order/) | Das Küchenbeispiel verwendet einen niedrigsten Kernprofilwert und benennt diesen als Demo. Das separate Detailkonzept 17 betont den relevanten Produktengpass. | Für allgemeine Produktklassifizierung Geltungsbereich und Voraussetzungen der Methode belegen. Das Küchenbeispiel liefert keine neue Produktregel. |
| [SDG-/SDG+-Referenzrahmen](https://wirkungsoekonomie.de/verstehen/sdgs-sdgplus/) | Der Einstieg nennt die Agenda 2030 und die WÖk-eigene Ergänzung. | Zielzuordnung, Datenbeobachtung, Kausalität und konkrete Schutzreferenz je Fall prüfen. |
| [Masterregister](https://wirkungsoekonomie.de/woek-id-register/) | Öffentliche Anzeige nennt v1.5 als kanonische Fassung. Die für diesen Auftrag geprüfte Referenz ist v1.4. Der Zeilen- und Formelabgleich steht im [Migrationsentwurf](revision/masterregister-migrationsentwurf.md). | Freigabefrage D-01 zur Version des öffentlichen Registers klären. |
| [Parlament](https://parlament.wirkungsoekonomie.de/) | Einstieg und Portalregeln beziehen Prüfungen auf politische Entscheidungen. Das lokale Portal-AGENTS verweist noch auf Begriffsleitfaden v1.5. | Fachakten und tatsächliche Wirkungsdaten auf Handlungsobjekt, Staatsevidenz, Attribution und Personenbezug prüfen. Der Entwurf korrigiert die Terminologiereferenz und ergänzt fehlende statische Listenweiterleitungen. |
| [Wirkungsticker](https://wirkungsoekonomie.de/wirkungsticker/) | Die maßgebliche operative Semantik trennt Potenzial, beobachtete Wirkung und Evidenz. Die aktuelle Produktionsregel verlangt gegenstandsbezogen begründete Pfade für alle drei MPD-Dimensionen eines laufenden Falls. | Die Regel bei Einzelfällen prüfen. Historische offene Dimensionen, modellierte Trägerschaft und Beobachtungsdaten getrennt behandeln. |
| [Studienstruktur](https://wirkungsoekonomie.de/akademie/studienstruktur.html) | Der öffentlich sichtbare Stand v4.0 weist die staatliche Prüfarchitektur und eigene Daten-/Methodenmodule aus. | Kurse, Folien und Zertifikatsanforderungen anhand ihrer tatsächlichen Fassungen prüfen. |

## Verifizierbare Deployments der getrennten Apps

GitHub führt für Akademie Commit `a3f91f598eb5f2cdc61b158a7924c0693fdd9236` vom 21.08.2026 und für Institut Commit `7252c0afa67802c728f4fc39aed171039e755555` vom 18.08.2026 mit erfolgreichem Production-Status. Beide Einträge verweisen auf frühere Vercel-Deployment-URLs. Die geprüften öffentlichen Custom Domains antworten über Caddy. Der zum Crawl-Zeitpunkt hinterlegte Runtime-Commit auf diesen Domains bleibt offen.

## Parlament-Navigation und Quellenstand

Das Live-Manifest gibt den Quellcommit `4227bca20b7c2bd0500e0ec1206710595d996966` an. Fünf Altadressen der Wirkungsfall-, Fachanalyse- und Ressortübersichten antworteten mit 404. Die jeweiligen Filteransichten bei `/wirkungsakten/` antworteten mit 200. Die im Next-Laufzeitbetrieb vorhandenen, exakten Regeln für Listenansichten werden im statischen Export als Weiterleitungen ausgegeben. Die Detailrouten verwenden weiter ihre eigenen Pfade. Suchparameter und Sprungmarken überstehen die Weiterleitung.

17 beim Crawl gefundene Quellenakten antworteten auch unter dem aktuell vorgesehenen Pfad im Prüfstandard mit 404. Vier sind in der aktuellen rheinland-pfälzischen Regierungsübersicht direkt auf den freigegebenen Originalwortlaut zurückführbar. Die externen Originale antworten mit HTTP 200. Der neue Renderer verlinkt eine vorhandene Quellenakte unter ihrer kanonischen URL. Fehlt die Quellenakte, wird der öffentlich freigegebene HTTPS-Originalverweis verwendet. Für die 13 übrigen historischen Links fehlt die Bindung an das Ausgangsdokument im aktuellen Checkout. Der aktuelle Checkout führt die rheinland-pfälzischen Quellen im statischen Register. Der erste lokale Export lief bei der Quellenliste wiederholt in 180-Sekunden-Timeouts. Der überarbeitete Export greift bei dieser Seitengruppe direkt auf die versionierten lokalen Quellen zu und baut den Quellenindex einmal pro Build-Prozess auf.

## Akademie-Bibliothek

Der öffentliche Bibliotheksspiegel basiert auf dem Rang-24-Downloadregister v1.0 vom Mai 2026. Abgleich und Korrektur für 20 PDFs der Pakete Migration & Vielfalt sowie Sicherheit & Resilienz stehen in [Akademie-PR 117](https://github.com/sustynats/woek-akademie-app/pull/117). Sämtliche neuen Ziele antworteten mit HTTP 200. Für zehn Word-Downloads aus Digitalisierung & KI (v2.0) fehlt die bestätigte öffentliche Originaldatei. Der Entwurf zeigt den offenen Direktzugang neben Portal und Materialien. Die einzeln betroffenen URLs stehen in der Dokumentenmatrix.

## Redaktionelle Modellportale

| Einstieg | Geprüfter Stand |
| --- | --- |
| [Agenda-Radar](https://wirkungsoekonomie.de/wirkungsradar/agenda-radar/) | Editoriale Priorisierung von Themen. Die Einstiegsansicht enthält keine Messreihe zur Verdrängung oder empirisch nachgewiesene Veränderung öffentlicher Aufmerksamkeit. Die thematischen Beispiele brauchen fallbezogene Nachweise. |
| [Resonanz-Kompass](https://wirkungsoekonomie.de/wirkungsradar/resonanz-kompass/) | Die Karten ordnen ausgewählte Aussagen und Frames ein. Qualitative Werte wie „hoch“ brauchen eine nachvollziehbare Herkunft und Beschreibung des Resonanzraums. Ihre empirische Geltung je Karte steht aus. |
| [Ursachen-Navigator](https://wirkungsoekonomie.de/wirkungsradar/ursachen-navigator/) | Der Einstieg unterscheidet Symptombeschreibung, möglichen Wirkpfad und Hebel. Die jeweils behauptete Ursache bleibt anhand eines Gegenfaktums und der konkreten Quellen zu prüfen. |
| [Debattenkarten](https://wirkungsoekonomie.de/wirkungsradar/debattenkarten/) | Die betrachteten Filter ordnen Aussagen ein. Jeder Folgencheck behält die Unterscheidung zwischen beobachteter Wirkung, Wirkungsrisiko und modelliertem Wirkungspotenzial. Die Einzelprüfung der Quellen, Zeiträume und Reichweiten in den 127 Karten ist offen. |

## Abgleich der WÖMS-Methodenregister

IDs und Titel wurden für alle 152 Methoden mit dem WÖMS-2.0-Original verglichen. Bei den 84 Grundmethoden stimmen auch 82 der im Originalindex ausgeschriebenen Kernoutputs überein. Die aktuelle D09-Karte folgt der späteren [T-SROI-Korrektur](https://wirkungsoekonomie.de/werkzeuge/impact-controlling/methodenpapiere/t-sroi-transformationsmessung/). D08 verwendet das eigenständige NWI-Wirkungsprofil und die Schutzprüfung. Die potenziell missverständliche Formulierung „bei offenem Gate“ ist in Methoden- und Glossardaten präzisiert. Die Methode verlangt eine bestandene Prüfung und ausreichende Evidenz. Die historische Originaldatei ist erhalten.
