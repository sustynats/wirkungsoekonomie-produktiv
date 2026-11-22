# Einordnung und SGMM: nachvollziehbarer Prüfstand

## Zuständigkeit und Freigabe

Website: ausschließlich `sustynats/wirkungsoekonomie-produktiv`, Ausgangscommit `4f53e589c167d6e1d335b2e09b0e881070ae339e`. `wirkungsoekonomie.de` wurde zunächst irrtümlich als Entwicklungsbasis verwendet; dort wurde kein Website-Commit veröffentlicht. Die Änderungen wurden gezielt auf das neue Produktionsrepository übertragen und dort neu geprüft.

Akademie: `sustynats/woek-akademie-app`. Institut: `sustynats/woek-institut-app`, nur untersucht, nicht verändert. Der Auftrag erteilt die redaktionelle Präzisierung; neue kanonische Editionen, neue Prüfungsfragen und persönliche Beiträge sind damit nicht freigegeben.

## Gezielte Änderungen

- Eine gemeinsame, datenbasierte Einordnung auf der vorhandenen Wissenschaftsseite; sechs knappe Einstiegshinweise und zwei datierte historische Hinweise. Keine neue Parallelseite und keine still geänderte historische Publikation.
- Glossarbegriff mit unveränderter ID, URL und Aliasliste. Technische Feldaliase für Definition und Einordnung bleiben inhaltsgleich. Kein Erstmaligkeits- oder institutioneller Anerkennungsanspruch.
- Acht Wissenschaftsseiten mit konsistenter Modell-/Rahmen-/Forschungsabgrenzung. Die bestehende staatliche Folgenprüfungsarchitektur bleibt anerkannt.
- Sechs externe Originalquellen mit Belegfunktion, Datum und tatsächlichem Prüfumfang im vorhandenen Quellenarchiv. SGMM 5.0 ist ein Arbeitspapier, keine HSG-Freigabe der WÖk. Public-Value-Forschung wird ausdrücklich anerkannt.
- Mini-Einheit in V03 und gezielte Ergänzungen in V49, V76 und WM-V4-01. Das Unternehmensbeispiel ist ausdrücklich hypothetisch. Keine 121. Vorlesung, keine Änderung bestehender Lernziele, Fragen, Kriterien, Versuche oder Zertifikate.
- Öffentlicher Skriptbestand und Akademie werden erhaltend abgeglichen: frühere September-/Oktober-Korrekturen bleiben erhalten. Kein historischer Bootstrap-Neuimport.
- Quellenarchiv-Brotkrumen erhalten ausreichend große Linkziele. Eine vorhandene, durch den Generator bereits korrekt verlinkbare Merriam-Webster-Quellenseite wird deterministisch aktualisiert; kein neues Fachurteil dazu.

## Bestandsprüfung

Das maschinenlesbare Fundstellen-/Publikationsinventar ist `reports/scientific-positioning-inventory-20261110.json`. Es zählt und lokalisiert Dateien; es ist ausdrücklich keine Behauptung einer vollständigen fachlichen Lektüre sämtlicher historischer Editionen.

Akademiequellen: 120 Grundstudiumsskripte, 58 Weiterbildungsskripte, unverändert 10 Teile und 40 Module. Die 22 JSON-Dateien unter Assessment-Pfaden umfassen auch Status-/Systemartefakte; sie sind nicht mit 22 aktiven Prüfungen gleichzusetzen. Die Laufzeit validiert 14 Studien-Assessments plus sechs Offering-Assessments.

Zusätzlich dateibasiert gezählt: 424 Markdown-Dateien in Lehrgangspfaden einschließlich historischer/gesonderter Fassungen, 77 Quiz-/Fragenpool-Dateien, fünf historische Assessment-Beschreibungen und fünf Zertifikats-/Nachweisbeschreibungen. Keine separat getrackten PPTX-/ODP-Foliendateien oder englischen Fassungen im Akademiecheckout gefunden. Dies schließt extern auf GitHub Releases oder privat gespeicherte Fassungen nicht aus.

Pflichtpfade G1.1, G5, G6, G8.2, G9.4 und G10 sowie Grundlagen, Wirkungsmanagement, Wirkungscontrolling und Multiplikator:innen wurden nach einschlägigen Aussagen durchsucht. Nur die vier oben genannten aktuellen Texte benötigen die hier beauftragte Ergänzung. Kein rückwirkender Austausch historischer Skripte.

## Nachweise

- Acht Website-Regressionstests: Modellumfang, wissenschaftlicher Status, koexistierende ökonomische Strömungen, SGMM-Arbeitspapier, Quellen, Glossar-Aliase, datierte Hinweise, vier hashgebundene Skriptprojektionen und Schutz originaler Quellen-URLs vor Formatwort-Ersetzungen.
- Drei Akademie-Regressionstests sowie Reader-/Quellen-/Assessment-/Curriculum-/Runtime-Tests bestanden. Next-Produktionsbuild, Typecheck, Lint und öffentlicher App-Smoke bestanden. Der erste Schriftabruf scheiterte; unveränderter Wiederholungslauf war erfolgreich.
- Neu im Produktiv-Repository: 178/178 normalisierte öffentliche Skriptkörper identisch zum geprüften Akademiequellbestand; 120/120 stabile Vorlesungs-IDs, sechs Offerings, öffentliche Metadaten zu 10+4 Studienprüfungen, strukturierte Daten, Such-/Sitemap-Verweise und Geheimnisschutz geprüft.
- Browser: 14 Routen bei 320/360/375/390/428/768/1024/1280/1440 Pixeln, insgesamt 126 Kombinationen. Keine 5xx, JavaScript-Fehler oder horizontalen Überläufe. Automatischer axe-Lauf für WCAG-A/AA einschließlich 2.2 bei 390/1440 Pixeln ohne Befund. Das ist keine vollständige WCAG-Zertifizierung. Desktop und mobile Darstellung zusätzlich visuell angesehen.
- Vollständiger Website-Release und Live-Prüfung werden erst nach dem tatsächlichen Workflow-Ergebnis als veröffentlicht bezeichnet. Alte Prüfergebnisse des Alt-Repositories ersetzen diese Freigabe nicht.
- Der historische Standhinweis steht außerhalb des ursprünglichen Publikations-`main`. Der unveränderte PDF-Quellenvergleich besteht: 0 Journal-PDFs neu erstellt, 171 unverändert. Die Regression prüft diese Trennung ausdrücklich; kein PDF-Gate wurde abgeschwächt.
- Ein vorhandener Format-Normalisierer ersetzte irrtümlich auch `word-history` in einer Quellen-URL durch `PDF-history`. Die minimale Reparatur schützt URLs einschließlich Pfad und Query vor Formatwort-Ersetzungen; sichtbare Download-Labels werden weiterhin normalisiert. Selbsttest und Publikations-/Quellenprüfungen bleiben streng.
- Die zwischenzeitliche main-Ergänzung zur Buchungsprojektion bleibt erhalten. Ihr neuer Initialisierungsaufruf wurde von zwei vorhandenen VM-Testausschnitten irrtümlich mit als Funktionstest ausgeführt. Beide isolieren nun ausschließlich die tatsächliche Pruner-Funktion. Die Prüfungen für öffentliches Buchungs-JavaScript, abzuweisende Quelldateien und verworfene Bildentwürfe bleiben unverändert wirksam. Nach lokalem main-Abgleich bestanden alle 102 gemeinsam ausgeführten Artefakt-/Buchungs-/Projektionsregressionen.

## Akademie-Betrieb

Der bestehende OCI-Runtime-Commit `06b1d230247ce3167f6535ef9896186fe078cc5b` enthält technische Ergänzungen, die im aktuellen App-main nicht vollständig vorhanden sind. Ein Vollapp-Deployment würde diese zurücksetzen. Deshalb ausschließlich isoliertes, hashgeprüftes Inhaltsrelease der vier Skripte, alle anderen Laufzeit-/Assessment-Dateien bytegleich, keine Datenbankmutation. Alter Release bleibt als Rückfallweg erhalten.

Erster Inhaltsstand `57bcd3ee1d69f42e0af0b93828742302d532cd7e`, App-Merge `4b305bf87855d464f31b158261c35aa51d0d2e9a`; Klarstellung des hypothetischen Beispiels in `9cb04ca8d522a79d0ab5ca2399bc4ec54b528f07`. Origin-Smoke `/`, `/studium`, `/kurse`, `/login`, `/zertifikat`, `/api/curriculum`: jeweils 200. Kein Zugangsschutz umgangen, keine authentifizierte Reader-Prüfung behauptet.

Die R2-Aktivierung wurde zunächst wegen des Startup-Zeitlimits auf den verifizierten Erststand zurückgerollt. Der spätere Wiederholungsversuch konnte nach einem SSH-Netzwerk-Timeout nicht abschließend dateibasiert bestätigt werden. Beide vorbereiteten Inhaltsreleases und der ursprüngliche Runtime bleiben erhalten. Die öffentliche IPv4-Domain und die Curriculum-API liefern wieder 200; der SSH-Host entspricht der öffentlichen Akademie-IP. Daraus wird ausdrücklich kein erfolgreicher R2-Zielhash- oder authentifizierter Reader-Nachweis abgeleitet. Diese Betriebs-Prüfgrenze bleibt vom bestandenen lokalen 178/178-Quellabgleich getrennt.

## Offene Autorinnenfreigaben und Prüfgrenzen

Kleine Addendum-Vorschläge für Leitfaden v1.8, Masterreferenz v3.0 und WÖMM/WÖMS 2.0 stehen in der Änderungsmatrix, bleiben aber Freigabeentwürfe. Originale, Buch-/Druckeditionen, historische Downloads und ihre Zitierbarkeit unverändert. Keine neue Buch-/PDF-Ausgabe und keine Publikation des persönlichen Word-/LinkedIn-Beitrags durch diesen Lauf. Auf dem inzwischen aktualisierten Produktiv-main wurde der separat veröffentlichte Journalbeitrag `/blog/st-gallen-managementmodell-wirkungsoekonomie.html` vorgefunden, gelesen und unverändert erhalten; daraus wird keine zusätzliche Autorinnenfreigabe für andere Fassungen abgeleitet.

Oracle-Masterreferenz am 10.11.2026 direkt verifiziert. Leitfaden §§3/10.9 sowie einschlägige Originalpassagen WÖMM/WÖMS gelesen. HSG-SGMM-5.0-Metadaten/Abstract über die offizielle API geprüft; nicht der vollständige Arbeitspapiertext. Public-Value-Quellen ebenfalls mit ausdrücklich begrenztem Leseumfang im Quellenarchiv dokumentiert.

Keine Scores, Registerkennungen, Schwellen, Formeln oder Steuerregeln geändert. Keine privaten Referenztexte oder Konfigurationen exportiert. Keine neuen kostenpflichtigen Dienste und kein Vercel-Build.
