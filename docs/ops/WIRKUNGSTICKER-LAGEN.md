# Betrieb der drei täglichen Wirkungsticker-Lagen

Stand: 9. November 2026. Historische Vereinbarung und Fenster:
[Umbau vom 17. September](../news/LAGEN-UMBAU.md).

Die Ausgabezeiten bleiben **06:00, 12:00 und 18:00 Uhr Europe/Berlin**.
Recherche und bezahlte Nachrichtenanalyse behalten ihren eigenen Takt und ihre
bestehenden Grenzen. Eine Lagenveröffentlichung ruft sie nicht erneut auf.

## Auslösung und Aufholung

Der zusätzliche Workflow wirkungsticker-lagen.yml prüft jeweils vier Minuten
nach dem Stichtakt. Zwei UTC-Cronzeilen decken Sommer- und Winterzeit ab.
Der erste Schritt verwirft vor Hydration die nicht passende Jahreszeit.
Eine innerhalb derselben Jahreszeit verspätete Ausführung bleibt zulässig.
Wird ein alter Cronlauf über den Sommer-/Winterzeitwechsel hinweg verzögert,
kann die Jahreszeitprüfung ihn verwerfen. Der nächste passende Lauf oder
der normale Nachrichtenlauf kann die dann fälligen Ausgaben nachholen.

lage-schreiben.mjs --check-due liest nur den Lagenbestand.
--missing-only erzeugt ausschließlich noch fehlende, bereits fällige Lagen
des **aktuellen Berliner Tages**. Vorhandene Ausgaben bleiben erhalten.
Vergangene Tage werden nicht nachgeschrieben, künftige Ausgaben nicht
vorgezogen. Ein Mitternachtswechsel zwischen Prüfung und Schreiben kann
daher zu keiner Änderung führen; dann folgen weder Build noch Commit
oder Deploy. Eine manuelle Auslösung unterliegt derselben Fälligkeitsprüfung.

Der reguläre Nachrichtenworkflow bleibt ein weiterer Aufholpfad.
Die bestehende Oracle-Clock ist eine getrennte Ausfallreserve. Dieser
Publisher beweist oder repariert deren tatsächliche Repositoryverbindung nicht.

## Speicherung und Veröffentlichung

Der Publisher verwendet keine Modell-, Redaktions-, Mail- oder Push-Secrets.
Er hydriert geprüfte vorhandene Daten, schreibt die fehlenden Lagen und prüft
den öffentlichen Build mit den bestehenden Validierungen und Größengates.
Abgesehen von data/news/lagen.json bleiben die versionierten kanonischen
Nachrichtenbestände bytegleich. Hydrationscache wird nicht committed.
Nur der Lagenbestand und erzeugte öffentliche Ansichten werden gestaged;
die App-Projektion wird wie bisher erst durch Pages vollständig gebaut.

Die regulären Nachrichten- und Lagenläufe teilen die Concurrency-Gruppe
wirkungsticker-main. Aktive Läufe werden nicht abgebrochen. GitHub kann
allerdings einen bereits wartenden Lauf durch einen neueren ersetzen.
Deshalb hat der neue Publisher keinen zusätzlichen Viertelstunden-Cron.
Die Aufholung aller fehlenden heutigen Lagen und der bestehende
Nachrichtenworkflow gleichen ausgelassene Warteläufe beim nächsten Start aus.

Ein zwischenzeitlich geänderter Mainstand stoppt den Veröffentlichungsversuch.
Es gibt in diesem Pfad keine Rebase-Reparatur, Releasepart-Persistierung,
Provider-Wiederholung oder automatische Pushwiederholung. Der normale
Fastforward-Push wird genau einmal versucht. Ein unklarer Push-/Dispatchausgang
darf nicht blind wiederholt werden.

Pages erhält den erfolgreich gepushten Commit ausdrücklich als ticker_commit
und skip_ticker_notify=true. Diese neue Option unterdrückt ausschließlich
App-Push für diesen Auftrag; ihr Standardwert bleibt false und verändert
bestehende Auslieferungen nicht. Es werden keine alten Notifyjobs wiederholt.

## Nachweise und Grenzen

**Keine Zusage minutengenauer Auslieferung:** GitHub-Cron kann verspätet
starten; danach muss der gemeinsame Pages-Build erfolgreich abschließen.
Erzeugter Lagenbestand, Git-Commit, Pages-Erfolg und tatsächlich öffentliche
Ausgabe sind getrennte Nachweise.

Permanente Node-Tests prüfen die wirklichen Inlineprogramme mit lokalen
Fakes: Sommer-/Winterzeit und Wechseltage, verspätete Starts, ungültige
Verträge, Mitternachts-No-op, kanonische Byteintegrität und Staginggrenzen.
Die vollständigen Workflowdateien müssen zusätzlich mit einem echten
YAML-Parser geprüft werden; die Node-Tests führen keine eigene YAML-Teilgrammatik
als Syntaxnachweis an. Vor Hosting-/Deploymentworkflowänderungen gelten die
bestehenden Hostingkostengates unverändert.
