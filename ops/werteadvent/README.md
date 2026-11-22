# Werte-Advent: interne Auswertung

Zusatzauftrag im Chat vom 19.11.2026: aggregierte Seitenstatistik plus freiwillige
Meldung eigener veröffentlichter TikTok-Beiträge. Die ursprüngliche Creator-Zentrale
ist unabhängig davon erreichbar. Favoriten und Erledigt-Häkchen bleiben lokal.

Die Statistik beginnt erst nach freiwilliger Aktivierung. Es gibt keine Cookies,
Nutzerprofile, dauerhaften Besucherkennungen oder gesammelten IP-/User-Agent-Daten.
Gezählt werden Ereignisse, keine einzelnen Menschen: geöffnete Tageskarten und
Klicks auf bestimmte Downloads. Ein Klick belegt keine Materialverwendung und die
Statistik mit Zustimmung ist keine vollständige Erfassung aller Seitenbesuche.
Die Beiträge sind ungeprüfte freiwillige Selbstmeldungen; keine Vollerhebung aller
TikTok-Verwendungen und kein Wirkungsnachweis. Keine öffentlichen Rankings.

## Private Speicherung

Python-Standardbibliothek, SQLite, eigener systemd-Benutzer, 0700-State-Verzeichnis
und 0600-Datenbank auf bestehender Oracle-Instanz. 64 MB RAM-/10%-CPU-Grenze,
keine neue VM, keine neue Cloud-Ressource, keine bezahlte API. Vor Aktivierung
waren rund 411 MB RAM verfügbar und 17 GB Platte frei. Caddy ergänzt nur den
abgegrenzten `/api/werteadvent/*`-Pfad. `skip_log` und deaktivierte Requestlogs in
der Anwendung verhindern IP-/Body-Protokolle für diese Funktionen.
Der Proxyzustand wird vor Änderung privat gesichert und bei Fehlern zurückgesetzt.

Meldungen brauchen Tageswert, kanonischen Beitragslink und ausdrückliche
Zustimmung. Es werden keine fremden URLs abgerufen. Nur vollständige HTTPS-Links
auf TikTok-Video-/Fotobeiträge werden akzeptiert. Query-Tracking und Fragmente
werden entfernt, doppelte Links pro Wert nur einmal gespeichert. Ein zufälliger
Löschcode erlaubt die Entfernung ohne Konto; nur dessen SHA256 bleibt serverseitig.
Der Code ist keine öffentliche Adresse und wird nicht automatisch lokal gespeichert.
Weitere Verwaltung ist ausschließlich über bestehendes autorisiertes SSH möglich,
es gibt keinen öffentlichen Statistik-/Admin-Endpunkt.

Der Timer löscht die privaten Meldungen am 1.2.2027, 00:00 Europe/Berlin; bei
Ausfall wird dies nachgeholt. Zusätzlich prüft der Dienst stündlich und beim Start.
SQLite secure_delete, WAL-Checkpoint und VACUUM entfernen die verworfenen
Datensätze. Aggregierte Zähler bleiben als nicht personenbezogene Auswertung
bestehen. Bei späteren Änderungen zuerst Datenbank mit SQLite-Backup sichern;
private Backups unterliegen derselben Aufbewahrungsgrenze und dürfen nie nach Git.

## Betrieb und Abruf

`python3 scripts/werteadvent/oracle.py deploy` verwendet die vorhandene private
SSH-Konfiguration außerhalb des Repositories. Es gibt keine neuen Tokens oder
Passwörter. Status: `python3 scripts/werteadvent/oracle.py status`.

Private aggregierte Auswertung:

```
python3 scripts/werteadvent/oracle.py stats --output output/werteadvent-statistik.json
```

`--include-reports` ergänzt die privat gemeldeten Links. Ausgaben bleiben lokal
und gehören nie ins öffentliche Website-Artefakt oder ein öffentliches Repository.
Einmalige synthetische Prüfungsmeldungen wurden nach dem Test wieder gelöscht;
der anschließende private Export war leer. Keine Testzähler wurden auf Production
erzeugt. Browser-Automation zählt keine Seitenereignisse.
