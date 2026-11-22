# Öffentliche Quellfassung und private Originalarchive

Die öffentliche Quellfassung beginnt mit der datenschutzgeprüften Generation
`2026-11-22-privacy-reviewed`. Sie enthält den vollständigen freigegebenen
Produktionsstand. Die bisherigen Git-Historien und unveränderten Originaldateien
bleiben privat erhalten. Das alte Website-Repository ist kein Veröffentlichungsziel.

Historische Download-Adressen werden über eine reine Download-Ablage erhalten.
Quelltext-Rettungsarchive bleiben privat. Technische Protokolle mit privaten
Pfaden werden ausschließlich mit datiertem Bereinigungsvermerk und ursprünglicher
SHA-256-Prüfsumme übernommen. Publikationsdateien behalten ihre geprüften Bytes.

## Bestehende Checkouts

Vor dem Wechsel zur neuen Git-Historie alle uncommitteten Arbeiten und bisherigen
Referenzen privat sichern. Einen frischen Checkout verwenden oder einzelne
geprüfte Änderungen übertragen. Die private Historie niemals mit
`--allow-unrelated-histories`, einem Force-Push oder alten Tags zurückveröffentlichen.
Der gemeinsame Remote bleibt `sustynats/wirkungsoekonomie-produktiv`.

Autor- und Committer-Adressen müssen GitHub-No-Reply-Adressen sein. Keine automatisch
erzeugten Startcommits verwenden, deren Kontometadaten noch nicht geprüft wurden.

## Verbindliche Prüfungen

- `npm run test:privacy`
- `npm run check:privacy:history`
- `npm run check:privacy:source`
- Nach dem Artefaktbau: `npm run check:privacy` und `npm run check:privacy:deep`

Der History-Test verlangt eine vollständige Historie. Der Pre-Push-Check
`scripts/quality/pre-push-public-privacy.sh` überprüft zusätzlich jeden neuen Blob
aller ausgehenden Commits. Dadurch blockiert auch ein inzwischen gelöschter
privater Zwischenstand den Upload. Vorhandene eigene Git-Hooks müssen bei seiner
Installation erhalten bleiben.

Die Prüflogs nennen nur relative Dateinamen und Fehlerklassen. Private Werte,
Oracle-Konfiguration, Masterreferenz und temporäre Zugriffslinks gehören weder in
das öffentliche Repository noch in Berichte oder Website-Artefakte.

## Veröffentlichungsfeeds

`WOEK_DISCORD_PUBLISHER_MODE=oracle_bot` aktiviert den bereits vorhandenen
Oracle-Publisher als zuständige Instanz. Die beiden GitHub-RSS-Jobs bleiben dann
inaktiv. Der Publisher führt eine dauerhafte Versandhistorie je Kanal und URL;
Migrationen übernehmen den vorhandenen Bestand ohne erneute Veröffentlichung.
