# UWP-100 Beta

Die öffentliche Seite verwendet die kuratierte Liste mit 100 Unternehmen und den geprüften Export `snapshots/uwp-100.public.latest.json`. Stabile Firmen-IDs bleiben bei Umfirmierungen erhalten. Der Stand der einzelnen Quellen und die Berichtsperioden stehen je Wert im Export.

## Monatlicher Betrieb

Der Workflow `uwp-monthly.yml` läuft am dritten Kalendertag um 05:19 UTC. Er aktualisiert die zugeordneten Registerangaben über die öffentliche Schnittstelle des Deutschen Bundestages. Er prüft Registernummer und Firmenname, übernimmt ausschließlich öffentliche aggregierte Ausgabenspannen und bindet sie an die konkrete Version des Registereintrags. Die PRTR-Schnittstelle des Umweltbundesamts liefert zusätzlich standardisierte Standortdaten für die zwei jüngsten Berichtsjahre. Pro Betrieb werden INSPIRE-ID, Standortname und Ort geprüft. Je Messgröße bleiben Einheit, Bezugsjahr, Erhebungsmethode, Quellenstand und Fundstelle erhalten. Die Daten sind nach API-Dokumentation CC0. Fehlende oder vertrauliche Mengen bleiben offen. Bei einem Abruf- oder Validierungsfehler bleibt der letzte veröffentlichte Stand erhalten. Jeder erfolgreiche Lauf prüft die Daten vor dem Commit und löst bei einer Änderung den bestehenden GitHub-Pages-Release aus. Der Git-Verlauf dokumentiert die veröffentlichten Stände.

Für einen manuellen Lauf oder eine lokale Prüfung:

```bash
python3 scripts/uwp/refresh-public-profile.py refresh
python3 scripts/uwp/refresh-public-profile.py validate
```

Die Liste geprüfter Register- und Standortzuordnungen sowie Berichtsfundstellen liegt in `public-sources.json`. Neu erschienene Unternehmensberichte werden nach Prüfung von Kennzahl, Berichtszeitraum, Abgrenzung und Fundstelle ergänzt. Die bisherigen Wikirate-Kennzahlen werden mit ihren Belegen als historische Sekundärdaten eingebunden. Das historische SBTi-Arbeitsmaterial bleibt intern. Öffentlich verfügbar sind der Export und die Firmenliste.

## Fachliche Weiterarbeit

- Für Unternehmen mit offener Datenlage zuerst Konzernberichte und amtliche Quellen eindeutig zuordnen.
- Quellenkontext je Kennzahl um Erhebungs- und Prüfverfahren, Systemgrenzen und kompatible Vergleichswerte erweitern.
- Für die Sektorbewertung kritische Felder, geprüfte Benchmarks und Schutzregeln fachlich festlegen. Nichtkompensation und Reverse Merit Order vor jeder Gesamtwertung anwenden.
