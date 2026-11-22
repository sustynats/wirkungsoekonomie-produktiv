# Persönliche Gesprächstermine

Stand: 3. November 2026. Implementierung für den nächsten zulässigen Release;
noch nicht produktiv aktiviert. Keine neue Vercel-Ressource, kein Vercel-Build,
keine Cloud-Buchung und keine Änderung bestehender produktiver Dienste.

## Ablauf

1. Profilseite `/w/natalie-weber/#gespraech`: 30 Minuten, Di/Mi/Do 10:00,
   10:30, 11:00 oder 11:30, Europe/Berlin. Ein Start ist inklusive mindestens
   sieben und höchstens 28 lokale Tage nach der aktuellen Uhrzeit zulässig.
   Sommer-/Winterzeit werden berücksichtigt.
2. Pflicht: Name, E-Mail, Telefon oder Discord-Sprachanruf, passender Kontakt,
   Anlass, Hintergrund, konkrete Vorfragen, gewünschtes Ergebnis, Kenntnisnahme.
3. Das Zeitfenster wird für 30 Minuten vorläufig reserviert. Telefonanfragen
   erhalten eine E-Mail aus der privaten Zustellwarteschlange. Ein GET/Klick
   allein bestätigt nichts: Die Bestätigungsseite verlangt einen aktiven POST.
4. Discord-Anfragen verwenden OAuth Authorization Code, Scope `identify`.
   Cookie, einmaliger Zufalls-State und Ablauf schützen die Zuordnung. Der
   tatsächliche Benutzername und die feste Nutzer-ID ersetzen den eingetippten
   Handle. Anschließend bestätigt die Person sichtbar ihren tatsächlichen
   Account und die Anfrage. Kein Passwort, kein Zugriff auf DMs/Serverlisten,
   keine dauerhafte Speicherung von OAuth-Zugriffstokens.
5. Erst die bestätigte Anfrage gelangt über den bestehenden Bot mit
   `DISCORD_BOT_TOKEN` / `DISCORD_REVIEW_RECIPIENT_USER_ID` als private DM an
   Natalie. Die Nachricht enthält Termin, Anlass und einen privaten Link;
   Kontaktdaten und freie Texte stehen auf der geschützten Verwaltungsseite.
6. Die Reservierung gilt nach dieser Verifikation 48 Stunden. Natalie sagt
   manuell zu/ab. Die Verwaltungsseite erstellt einen E-Mail-Entwurf oder einen
   kopierbaren Discord-Antworttext. Sie sendet keine automatische Terminzusage.
   „Antwort versandt“ dokumentiert die persönliche Zustellung.
7. Bei aktivierter iCloud-Anbindung wird unmittelbar vor der Zusage „Nats“ auf
   Konflikte geprüft und ein privater Eintrag mit stabiler UID und Erinnerungen
   24 Stunden und 30 Minuten vorher angelegt. Ohne Anbindung steht eine ICS-Datei bereit.
   Eine Absage entfernt ausschließlich diesen eigenen automatisch angelegten
   Eintrag. Manuell importierte ICS-Einträge müssen manuell entfernt werden.

Die E-Mail-Adresse bei Discord-Anfragen wird nicht zusätzlich verifiziert.
Die Verwaltung zeigt das ausdrücklich an. Eine Discord-Identitätsprüfung
belegt weder Servermitgliedschaft noch offene DMs oder Erreichbarkeit für
Sprachanrufe; diese Einstellungen muss die Person zulassen. Es gibt keine
Video-/Teams-/Zoom-/Meet-Termine und keine automatischen Kalendereinladungen.

## Betrieb auf vorhandener OCI-Infrastruktur

Die API ist eine Flask-/Gunicorn-Anwendung mit privatem SQLite auf einem
persistenten lokalen OCI-Volume, nicht auf NFS, GitHub oder Vercel. Atomare
Transaktionen und ein partieller Unique-Index verhindern Doppelbuchungen,
auch bei mehreren gleichzeitig eintreffenden Anfragen. Ein separater Worker
liefert die E-Mail-Verifikation und Discord-DMs aus. Vor jedem Versand wird
der Auftrag persistent auf HOLD gesetzt. Bei Fehler oder Prozessabbruch bleibt
der Ausgang unklar und wird nicht automatisch wiederholt; neue Anfragen werden
angehalten. Vor einer Wiederaufnahme muss die tatsächliche Zustellung geklärt
werden. Der Bestand bleibt bis zu seiner regulären Löschfrist erhalten.

GitHub Pages kann das statische Formular hosten, aber weder private Daten
speichern noch eine solche API ausführen. OCI kann den vorhandenen HTTPS-
Host samt API bedienen. Dieser Kandidat trennt den öffentlichen Profil-Origin
`https://wirkungsoekonomie.de` vom API-Origin `https://130.162.217.58.sslip.io`.
Nur Slots und Anfragen sind vom Profil-Origin per CORS erreichbar;
Verifikation und Verwaltung bleiben am API-Origin. Der Discord-OAuth-Callback
liegt daher am API-Origin. Die vorhandene Domain-/Proxy-Topologie ist vor dem
Release zu prüfen. Das vorhandene Vercel-Hosting wird nicht geändert oder
als Grund für einen neuen Vercel-Build verwendet. Vorhandene OCI-Kapazität,
Kosten, TLS, Sicherung und Ressourcenverbrauch sind vor Aktivierung live zu
prüfen. Vorbereitete Grenzen: API 256 MB / 25 % CPU, Worker 128 MB / 15 % CPU.
Das sind Limits, keine bestätigte freie Kapazität und keine Ausgabefreigabe.

1. Geprüftes Commit-Artefakt mit `ops/telephone-booking/` und
   `content/natalie/telephone-booking.json` nach `/opt/woek-booking/releases/…`
   bringen. Bestehende Dienste und nginx-Konfiguration vorher sichern.
2. Dedizierten Benutzer `woek-booking`, externes Verzeichnis
   `/var/lib/woek-telephone-booking` (0700) und Python >= 3.11 verwenden.
3. In einer venv `pip install -r requirements.lock` ausführen.
   `requirements.txt` führt direkte Abhängigkeiten, der Lock alle geprüften
   Abhängigkeiten. Tests und Build laufen lokal/GitHub.
4. Private `/etc/woek-telephone-booking.env` nach `.env.example` bereitstellen,
   0600 und root-eigen; keine echten Werte in Chat, Git oder öffentlichen
   Artefakten. `BOOKING_SECRET` einmalig kryptographisch zufällig erzeugen
   (mindestens 32 Zeichen). Ein Wechsel macht bestehende Links ungültig.
5. Bestehenden Discord-Bot und Empfänger verwenden; OAuth-Callback exakt
   `https://130.162.217.58.sslip.io/api/telephone-booking/discord/callback`
   bei derselben freigegebenen Discord-Anwendung registrieren. Client-Secret
   und Bot-Token bleiben ausschließlich serverseitig.
6. Bestehenden SMTP-Versand konfigurieren. STARTTLS ist zwingend. Keine
   Newsletter-Anmeldung, keine Werbenachricht; nur Bestätigungslink.
7. iCloud mit App-spezifischem Passwort anbinden. Ohne aktivierte Kalenderprüfung
   werden produktiv keine freien Termine angeboten; die gesetzte Aktivierung
   allein belegt keine funktionierende Verbindung. Es wird exakt
   ein bestehender beschreibbarer Kalender mit Namen „Nats“ erwartet. Keine
   Ersatzkalender werden still angelegt. Die Codex-iCloud-Verbindung wurde
   am 03.11.2026 erfolgreich gelesen: „Nats“ ist vorhanden und beschreibbar.
   Nach bestätigter Plugin-Verbindung wurde auch der Kalender-Lesezugriff im
   Buchungszeitraum erfolgreich geprüft. Dabei wurden keine Termine angelegt,
   verändert oder gelöscht. Private Kalender-IDs und Ereignisdaten werden
   nicht im Repository gespeichert.
   Diese interaktive Verbindung stellt keine Server-Credentials bereit.
8. Beide systemd-Units und bestehende HTTPS-Proxy-Konfiguration prüfen;
   `nginx.conf.example` liefert den Routenbaustein, keine komplette Site.
   Nur der vertrauenswürdige Proxy darf `X-Real-IP` setzen. Gunicorn lauscht
   auf Loopback. Proxy/Tracing dürfen keine Request-Bodies, Authorization,
   OAuth-Queries oder Cookies protokollieren.
9. Erst nach realem Smoke-Test `BOOKING_ENABLED=1` setzen. Ohne laufenden
   Worker oder bei überfälliger Zustellwarteschlange werden neue Anfragen
   mit 503 abgewiesen. `/health` muss überwacht werden. Bei dauerhaftem
   Discord-/SMTP-Fehler die Zustellung reparieren, nicht Tokens protokollieren.
10. Profilgenerator und Suchindex bauen, statisches Artefakt prüfen,
    erlaubtes Deployment ausführen, Live-Profil, Navigation, Suchergebnis,
    Telefon-/Discord-Verifikation, Owner-DM, Zusage, Kalender und Absage testen.

### iCloud-Zugang auf Oracle einrichten

`setup_icloud.py` verwendet den vorhandenen privaten SSH-Zugang aus
`~/.config/woek-reference/config.json`. Ein abweichender privater Konfigurationspfad
kann mit `--config` angegeben werden. Der Host-Key muss bereits bekannt sein;
SSH und `sudo -n` müssen funktionieren. Das Skript benötigt nur Python-Standardbibliotheken.

```sh
python3 ops/telephone-booking/setup_icloud.py --check
python3 ops/telephone-booking/setup_icloud.py
```

Die Einrichtung fragt erst nach erfolgreicher Oracle-Verbindungsprüfung nach
Apple-Account und App-spezifischem Passwort. Die Eingabe des Passworts erfolgt
verdeckt in einem interaktiven Terminal; niemals das normale Apple-Passwort,
Kommandozeilenargumente oder Chat-Nachrichten verwenden. Das App-Passwort wird
manuell unter [Apple Account](https://account.apple.com/) erstellt, beispielsweise
mit dem Namen „WOeK Oracle Termine“.

Das Skript überträgt die Eingaben ausschließlich über SSH-Standardeingabe und
prüft auf dem Server per HTTPS/CalDAV, dass genau ein bestehender Kalender
„Nats“ vorhanden ist und Ereignisse erstellt, aktualisiert und entfernt werden
dürfen. Erst danach schreibt es die root-eigene Datei
`/etc/woek-telephone-booking-icloud.env` mit Modus 0600. Die konkrete Kalender-URL
wird dort fixiert; private IDs und Zugangsdaten erscheinen nicht im Repository
oder in der Statusausgabe. Weiterleitungen sind ausschließlich zu Apples
CalDAV-Hosts über HTTPS erlaubt.

Eine bestehende Konfiguration wird standardmäßig nur geprüft. `--replace`
ersetzt sie nach erfolgreicher Prüfung und legt vorher eine private Sicherung
mit der Endung `.backup` an. Beide systemd-Units lesen die zusätzliche Datei
nach der Basiskonfiguration. Die Einrichtung allein startet keine Dienste und
verändert keine Termine. Aktivierung und echter Kalender-Smoke-Test folgen im
geprüften Backend-Release; der interaktive Codex-Kalenderzugang ersetzt diesen
Server-Test nicht.

### Datenschutz und Rückfall

Bestätigungs-/Verwaltungstokens liegen im URL-Fragment, nicht im Querystring.
Nach dem Öffnen entfernt JavaScript das Fragment aus dem Verlauf; API-Zugriff
verwendet Bearer-Header. Links wirken wie Passwörter und dürfen nicht geteilt
werden. Öffentliche Antworten enthalten nur freie Slots, keine Kontaktdaten.
Keine Tracker auf den privaten Verwaltungs-/Verifikationsseiten.

Unbestätigte Anfragen verfallen nach 30 Minuten und werden innerhalb eines
Tages gelöscht. Abgeschlossene Anfragen/Termine werden nach 30 Tagen aus
SQLite gelöscht. Der aktivierte Worker führt die Bereinigung kontinuierlich aus;
bei deaktiviertem Worker ruht sie und muss für die Löschfristen anderweitig
gesichert werden.
SMTP-/Discord-Nachrichten, iCloud-Einträge und Sicherungen haben getrennte
Lebenszyklen. Betreiber müssen deren Aufbewahrung/Löschung sowie die
Datenschutzerklärung vor Freischaltung für diesen Ablauf prüfen. Die
Formularhinweise legen keine neue Rechtsgrundlage fest.

Private Backups über die SQLite-Backup-API konsistent erstellen, verschlüsselt
auf bewilligtem privaten OCI-Ziel ablegen und Ablauf begrenzen (höchstens
30 Tage für diese Buchungsdaten). WAL/SHM und Backups gehören niemals in
Website-Artefakte. Für den Rückfall zuerst API und danach Worker stoppen und
deren tatsächlichen Stillstand kontrollieren; ein bereits laufender externer
Versand kann noch unklar sein und bleibt nach dem Zustellguard auf HOLD. Erst
danach `BOOKING_ENABLED=0` in der privaten Konfiguration setzen und bei Bedarf
die API im deaktivierten Zustand neu starten. Die Environment-Datei wird bei
Dienststart eingelesen; ihre Änderung allein ändert einen bereits laufenden
Worker nicht. Beim Start mit `BOOKING_ENABLED=0` greift der Worker weder auf
die Queue zu noch versendet oder löscht er Anfragen. Daten und offene HOLDs
erhalten; vor Wiederaufnahme Zustellstatus und Löschfristen prüfen. Das
vorherige statische Release bei Bedarf zurückspielen. Keine automatische
Migration oder blinde Wiederholung unklarer Zustellungen.

## Prüfungen

```sh
node scripts/natalie/build-natalie-pages.mjs
node scripts/search/build-woek-search-index.mjs --only-directory=w/natalie-weber
python -m unittest discover -s ops/telephone-booking/tests -v
node --check assets/js/telephone-booking.js
node --check ops/telephone-booking/static/manage.js
node --check ops/telephone-booking/static/verify.js
npm run check:hosting-cost
```

Für Browsertests `tests/serve_preview.py` mit der Test-venv auf Loopback
starten. Ausschließlich synthetische Daten; SMTP, Discord und iCloud werden
dort nicht kontaktiert. Dieser Preview-Server darf nie öffentlich laufen.
`tests/browser.mjs` verwendet Playwright (über `BOOKING_PLAYWRIGHT` aus einer
separaten Testinstallation ladbar) und prüft alle acht Profilseiten mobil und
am Desktop. `BOOKING_GLOBAL_CSS` kann das aktuelle globale Stylesheet angeben;
es wird nach dem Profil-CSS eingebunden, um den früheren Kontrastfehler zu
reproduzieren. Unveränderte öffentliche Schrift-/Bilddateien werden dabei vom
Live-Host geladen. Die beiden Buchungswege verwenden nur lokale Testdaten und
einen simulierten Discord-OAuth-Anbieter.

## Lokaler Prüfstand vom 03.11.2026

- 22 Backendtests bestanden: Validierung, Zeitfenster/DST, konkurrierende
  Reservierungen, Einmal-Links, Discord-State/Cookie/Accountprüfung, Zustell-
  Wiederholung, Freigabe, Absage, iCloud-Konflikt/Ausfall, Erinnerungen,
  Datenlöschung und Worker-Bereitschaft.
- 10 zusätzliche iCloud-Einrichtungstests bestanden: Apple-Hostbegrenzung,
  Kalenderauswahl und Schreibrechte, sichere Weiterleitungen, unveränderte
  Bestandskonfiguration bei Fehlern, private Sicherung/Dateirechte,
  Symlink-Abweisung, Passworttransport nur über Standardeingabe sowie
  fixierter Kalender im Laufzeitbetrieb. Sämtliche Testdaten sind synthetisch.
- Browserprüfung aller acht Profilseiten mit dem live ausgelieferten globalen
  CSS und axe-core-Farbkontrastprüfung bestanden; keine horizontale Überbreite
  bei 390 Pixeln. Gemessener
  Kontrast des goldenen Primärbuttons: 6,81:1. Haupttitel und Einleitung über
  dem dunkelblauen Grund: 14,48:1 beziehungsweise 11,20:1.
- Website-Farbregeln sind auf `#natalie-profile` begrenzt, einschließlich
  Unterseiten und Media Queries. Die globale Navigation bleibt unabhängig.
- Öffentlicher Hinweis auf Profil/Presse/FAQ: aus privaten Gründen keine
  öffentlichen Auftritte oder persönlichen Treffen vor Ort; ausgewählte
  Telefon-/Discord-Audiogespräche erst nach persönlicher Zusage.
- Hosting-Policy-Gate bestanden. Der vollständige Artefaktbuild und die
  vollständige Suchgenerierung wurden wegen blockierender Datei-Lesezugriffe
  im bestehenden Checkout abgebrochen (u.a. Public-Release-Manifest und eine
  nicht betroffene Blogseite). Das ist kein bestandenes Release-Gate.
- Gezielter Profilbuild, alle lokalen Linkziele sowie die Aktualisierung des
  Suchindex einschließlich Browserindex und Metadaten bestanden (acht Seiten
  plus Kontaktabschnitt). Der gezielte Suchlauf erhält alle übrigen Einträge;
  atomarer Dateitausch verhindert blockierende Schreibzugriffe auf vorhandene
  Cloud-Platzhalter und unvollständig geschriebene JSON-Indizes.
- Keine echte SMTP-/Discord-Nachricht, kein Testtermin in iCloud und kein
  produktives Deployment durchgeführt. Server-Credentials, OCI-Kapazität,
  HTTPS-Routing und echter Zustell-/Kalender-Smoke-Test bleiben Release-Gates.

Quellen: [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2),
[Discord Nutzer und DM](https://docs.discord.com/developers/resources/user),
[CalDAV-Client](https://caldav.readthedocs.io/stable/tutorial.html),
[Apple: App-spezifische Passwörter](https://support.apple.com/102654).

## Ergänzung 19.11.2026: Gesprächsverlauf und Kalenderübernahme

Das Instituts-Inhaberportal verwendet `/internal/crm` ausschließlich über
Loopback mit einem separaten `BOOKING_CRM_TOKEN`. Proxy- und Origin-Header
werden abgewiesen. `crm_contacts`, `crm_identities` und `crm_meetings` bewahren
die beauftragte private Kontakt- und Gesprächshistorie getrennt von den regulär
bereinigten Buchungsanfragen. Nur bestätigte Termine werden automatisch
übernommen; vergangen bedeutet nicht automatisch stattgefunden. Notizen sind
pro Termin versioniert. Kalenderimporte enthalten niemals diese Notizen.

Bestätigungsmails haben zusätzlich eine HTML-Fassung mit Kalender-Schaltflächen.
Apple verwendet einen HMAC-geschützten ICS-Download über die Institutsdomain;
Google und Outlook öffnen die bekannten Terminvorlagen. Die ICS-Datei bleibt
als Anhang erhalten. Bestehende Zustell-HOLDs und Legacy-Queues bleiben erhalten.
Nach Absage liefert der Download keinen Termin mehr. Bereits importierte
Einträge aktualisieren sich weiterhin nicht automatisch.
