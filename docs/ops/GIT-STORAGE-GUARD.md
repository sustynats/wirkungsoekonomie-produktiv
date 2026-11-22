# Git-Speicherprozess

Status: lokal vorbereiteter Prüfkandidat mit Staging-/Ausgangsbereichsprüfung, Ticker-Publish-/Recovery-Gates, sieben angepassten Workflowdateien und API-Vorschreibegates. Noch keine Aktivierung in GitHub. Vollständige Schreiberinventur, unabhängige Alarmzustellung, Wiederherstellungsprobe und Remote-CI bleiben Pflicht vor Produktionsabschluss.

## Bestand und Ablage

Git enthält Code, Quellen und kleine Steuerdateien. Große unveränderliche öffentliche Daten liegen im vorhandenen GitHub-Release-System mit SHA-gebundenen Manifesten; persönliche Texte und Nutzerdaten in der vorhandenen privaten Ablage. Das bestehende `release-data.mjs` wiederverwendet identische Objekte und kontrolliert die Anzahl von Release-Dateien. Es wird weiterverwendet. Kein neuer Dienst, Tarif oder Vercel-Build ist erforderlich.

## Prüfung vor dem Schreiben

`check-git-size.mjs` erhält zusätzlich zur bestehenden 95-MiB-Dateigrenze drei Prüfungen: rohe Tickerparts dürfen nicht erneut in Git landen; Stories/Newsroom dürfen nur kleine, vollständig releasegebundene Manifeste sein; der zusätzliche komprimierte Git-Transport der vorgemerkten Änderung darf 8 MiB nicht überschreiten. Eine kleine Änderung am bestehenden großen Suchindex wird anhand des tatsächlichen zusätzlichen Transports beurteilt.

Die Prüfung muss nach dem Staging und vor jedem automatischen Commit laufen. Zusätzliche Änderungen nach Rebase oder Wiederaufnahme müssen erneut geprüft werden. Vor Push ist außerdem der gesamte noch nicht veröffentlichte Commitbereich zu prüfen; eine Prüfung eines leeren Stagings genügt dafür nicht. Direkte GitHub-API-Schreiber brauchen dieselbe Speicherentscheidung vor ihrem Anbieteraufruf. Keine unbekannte oder von GitHub abgewiesene Schreibwirkung wiederholen.

`node scripts/news/check-git-size.mjs --base=<geprüfter Remote-Commit> --automatic` prüft vor einem Push den gesamten noch nicht veröffentlichten Commitbereich. Die Basis muss ein vorhandener Vorfahr sein; maximal 64 ausgehende Commits werden geprüft. Jeder darin neu eingeführte oder geänderte Blob und der gesamte zusätzliche Thinpack werden kontrolliert. Ein zwischenzeitlich eingecheckter und vor HEAD wieder gelöschter Rohpart oder großer Blob bleibt damit sichtbar. Es gibt keine Netzabrufe oder Ref-Änderung durch diese Bereichsprüfung; die Messung der Repositorygröße ist ein separater lesender API-Aufruf.

`publish-git.mjs` prüft auf dem normalen Produktionspfad jetzt vor jeder Rebase-Fortsetzung mit vorgemerkten Änderungen, vor jedem regenerierten Commit und vor jedem Push nach Rebase/Recovery. Der geprüfte Head wird vor dem Push erneut gebunden und als exakter Commit im Push-Refspec verwendet. Ist dieser exakte Commit bereits auf dem frisch gelesenen Main, entfällt die Schreibprobe. Gatefehler gelangen nicht in die Push-Wiederholung. Eine ausdrücklich erkannte Repository-Größenquota oder Datei-Hartgrenze stoppt sofort nach dem ersten Anbieterfehler. Die bestehende begrenzte Wiederholung bei parallelem Main bleibt erhalten. Historische Merge-Unitfixtures verwenden bewusst eine isolierte Gate-Testdoppelung für ihre alten Rohformate; separate Integrationstests prüfen die tatsächliche Produktionssperre vor Commit/Fortsetzung/Push.

Die vier bekannten Git-Schreiber erhalten im lokalen Kandidaten Prüfungen vor Commit und Push, der Autopilot zusätzlich nach erneutem Staging vor Amend. Vor Ticker-/Autopilot-Verarbeitung und vor Discord-RSS-Veröffentlichung prüft `--preflight` die aktuelle Größe ohne Git-Zustandscommit. Ungültige Messungen stoppen immer; die Gesamtschwelle greift erst mit der ausdrücklich gesetzten Aktivierung nach Bereinigung. Der reine Messstatus ist kein Nachweis, dass der Anbieter seine aktuelle Schreibsperre aufgehoben hat. Für den historischen #253-Zielbranch muss die geprüfte Guardfassung vor einem späteren Einsatz ebenfalls vorhanden sein; fehlende Guarddateien stoppen. Der alte Reparaturworkflow wird durch diese Vorbereitung weder gestartet noch neu installiert.

Beide Discord-RSS-Workflows prüfen vor Ref-/Contents-Mutationen die exakten neuen Rohbytes, das erlaubte Ziel und eine aktuelle Größenmessung. Der Operationsmonitor verwendet denselben Schutz vor Branchanlage und vor jedem Zustands-PUT. API-Steuerdateien sind auf 512 KiB begrenzt; rohe Tickerparts, rohe Hauptstores, unlesbare Messungen, ungültiges JSON/UTF8 und unsichere Pfade werden vorher abgewiesen. Ein Gate auf Git-Staging oder Push allein schützt diese API-Schreiber nicht. Der Monitor erhält seine bisherige Outbox-vor-Zustellung-Reihenfolge. Seine derzeitige Git-Zustandsablage ist damit noch nicht unabhängig; deren backup-first Ersatz bleibt eine offene Betriebsaufgabe.

Für Version2-Manifeste wird der bestehende `newsroomParts`-Iterator verwendet: ein großer logischer Datensatz darf weiterhin in einzeln begrenzte, vollständig hash-/releasegebundene Blätter zerlegt sein. Container werden nicht mit transportierten Blattdateien verwechselt. Die bestehenden Größen- und Quellbindungsgrenzen werden dafür nicht geändert.

Vor Änderungen an Hosting-/Deploymentworkflows werden die vorgeschriebenen frischen Hostingkostengates ausgeführt; private Kontobefunde gehören nicht ins öffentliche Repository. Aktuell erfasst sind vier Workflow-Git-Schreiber und drei direkte Contents/Ref-Schreiber. Lediglich lesende GitHub-Tree-Abfragen und lokale Bridge-POSTs werden nicht als Repository-Schreiber gezählt. Die dynamische/gewrappte sowie installierte Oracle-Fassung ist noch zu auditieren. YAML-Syntax und echte lokale Workflow-Shell-/API-Verhaltenstests ersetzen keine vollständige exakte Remote-CI oder Live-Aktivierung.

## Gesamthistorie und Alarmierung

Nach erfolgreicher Bereinigung wird die gemessene Baseline festgehalten und `enforce_total_repository_after_cleanup` aktiviert. Interne Startwerte sind 5 GiB Warnung und 8 GiB Stopp automatischer Daten-Schreibvorgänge. Das sind eigene Schutzwerte, keine behauptete GitHub-Sperrschwelle. Die vorhandene Schreibsperre wird nicht umgangen. Kleine reguläre Reparatur-Releases nach einer Anbieterentsperrung müssen nicht auf die vollständige Historienbereinigung warten.

`node scripts/ops/check-repository-storage.mjs` liest die Repositorygröße ohne Checkout oder Git-Zustandscommit und gibt einen JSON-Bericht aus. Unbekannte Messung: Exit1; interne Warnung: Bericht/Exit0; interner Stopp: Exit2. Der Bericht benennt ausdrücklich, ob die Gesamtsperre schon aktiviert ist. Eine interne Schwelle ist kein Beweis einer GitHub-Providersperre. Dieser lokale CLI-Prototyp ist noch nicht an einen Scheduler oder Versand angeschlossen.

Der vorhandene Codex-/Betriebsmonitor soll diese Größe unabhängig von Git-Schreibzugriffen überwachen. Alarmzustand und Zustellung dürfen nicht vom Zurückschreiben in dasselbe Repository abhängen. Er meldet Grenzübertritte und neue Fehler, wiederholt unveränderte bekannte Sperren nicht. Die spätere automatische Schreibbremse muss vor zusätzlichen bezahlten Verarbeitungsschritten greifen. Bestehende Paid-/Inhalts-/Quellen-/Freigabe-/Serialisierungsgates bleiben erhalten.

## Aufbewahrung und Entfernung

Die Nutzerin hat erlaubt, endgültig verworfene, nie veröffentlichte Rohkandidaten ohne benötigte Abhängigkeit ohne zusätzliche Inhaltsarchivierung zu verwerfen. Ein aktuell nicht gesetztes `published`-Flag allein reicht nicht. Veröffentlichte Fassungen und Quellen, offene/unklare Aufträge und Freigaben, persönliche und bezahlte Entwürfe, versiegelte Originale sowie alle RSS-/Podcast-/API-/Leser-Abhängigkeiten bleiben geschützt. Gemischte oder unklare Datensätze bleiben `REVIEW_REQUIRED`.

Für verworfene Rohkandidaten werden nötige kleine Dubletten- und Abschlussvermerke erhalten; die Rohtexte müssen dafür nicht weitergetragen werden. Damit werden abgeschlossene Aufträge nicht erneut analysiert oder kostenpflichtig erzeugt. Bereits vorhandene Backups werden nicht automatisch gelöscht.

Vor Entfernung erhaltenswerter Daten: aktuellen Ref-/Quellstand binden, Nutzungs- und Referenzgraph prüfen, extern sichern, vollständig unabhängig rücklesen, Wiederherstellung prüfen, danach gezielt entfernen. Veröffentlichung, Freigabe, GUID, Medien-URL und Quellenbezug dürfen nicht allein aus einer technischen Queue oder Dateigröße abgeleitet werden.

## Wiederherstellung und regelmäßige Kontrolle

Regelmäßige Stichproben prüfen die Wiederherstellung aus der externen Ablage mit Hash-, Format- und Verbrauchertests. Vor einer größeren Bereinigung ist eine vollständige Probe des konkret zu erhaltenden Umfangs Pflicht. Alle sieben RSS-Feeds und acht derzeitigen Podcast-Enclosures werden einschließlich GUIDs, Links, Daten und Medien geprüft. Signierte Originalcommits und Tag-/PR-Bezüge werden bei der einmaligen Historienbereinigung berücksichtigt.

Historienumschreibungen sind kein geplanter regelmäßiger Wartungsjob. Der dauerhafte Schutz entsteht durch richtige Ablage, Vorschreibegates, messbare Wachstumskontrolle und geprüfte Retention. Ein Rewrite oder das Entfernen aus dem aktuellen Baum gilt erst nach gemessener serverseitiger Freigabe als Platzgewinn.

## Nachweise vor Aktivierung

- Alle Git- und API-Schreiber sind erfasst und vor jedem Schreib-/Wiederaufnahmepfad geprüft.
- Rohdatenregression und ungültige Messungen blockieren; kleine gültige Indexänderungen funktionieren.
- Gesamtgrößenmonitor und Alarmierung funktionieren ohne Repository-Schreibzugriff.
- Aufbewahrungsumfang und Ausschlüsse sind inhaltlich und referenzbezogen belegt.
- Exakte neue Remote-CI, regulärer Release und Live-/RSS-/Medienprüfung sind bestanden.
- Nach bereinigter Baseline ist die 5-/8-GiB-Gesamtbremse tatsächlich aktiviert.
