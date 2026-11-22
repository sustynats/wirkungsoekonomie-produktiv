# Masterregister Migration für einen Wirkungspass

Entwurf 0.1 vom 14. November 2026. Vorgeschlagen ist eine ergänzende, versionierte Ablage für Evidenz und Klassifizierungsstatus.

| Original | Nachgesehener Anker | Folgerung |
| --- | --- | --- |
| v1.4 FINAL vom 16.08.2026 | 11 Blätter, 621 WÖk-IDs in `01_Item_Register` | Register-ID und Produkt-ID bleiben eigene Schlüssel. |
| `01_Item_Register!A5:J5`, `03_Scoring_Rules` und `06_Scorecards!N5` | WOK-S-101, Regel R27. Die Formel prüft die Grenzen 40, 60, 80 und 95. | 50 % ergeben als modelliertes Einzelbeispiel -2, 90 % ergeben +2. Die Schwellen sind WÖk-Arbeitskalibrierung. |
| `06_Scorecards!N5:P5` | AutoScore, aktiver Benchmark und numerischer Assurance-Wert ergeben das strengste vorhandene Zeilenergebnis. | Die Regel gilt für die Zeile. Ein leerer Messwert erzeugt keinen AutoScore. Auch ein vorliegender Assurance-Wert belegt keine vollständige Produktbewertung. |
| `04_Tarifmodell!A6:D12` | -3/25 %, -2/20 %, -1/15 %, 0/10 %, +1/5 %, +2/0 %, +3/0 %, Arbeitsmodell v1.3 | Fassung und Tabellenausschnitt am Szenario führen. Das frühere Fünfklassenmodell steht darunter. |
| v1.5 vom 21.08.2026 | Blätter 11 (Two Level Architecture), 12 (State Reference Crosswalk), 13 (Changelog) | Die sichtbare Webprojektion enthält 621 eindeutige, gegenüber v1.4 unveränderte IDs. Der Vergleich der Tabellen steht unten. |

## Vergleich der Arbeitsmappen

- Die Originaldatei v1.4 und ihr öffentlicher Download haben unterschiedliche Prüfsummen. Nach Normalisierung von Bindestrichen stimmen die betrachteten Blätter 01, 02, 03, 04 und 06 zellweise überein. Die herunterladbare v1.5-Datei hat dieselbe Prüfsumme wie die Generatorquelle im Repository.
- In Blatt 01 unterscheiden sich nach derselben Normalisierung nur Versionskennzeichnung und Gültigkeitsbeginn. Die Werte in den 28 Regelzeilen in Blatt 03 und im Datenbereich der Tarifvarianten in Blatt 04 sind gleich. In Blatt 02 sind 64 numerische Änderungen auf die letzten Nachkommastellen beschränkt.
- In Blatt 06 wurden in allen 621 Zeilen die sieben Formelspalten N bis S und W verglichen. In 18 AutoScore-Formeln unterscheidet sich der Formeltext durch zusätzliche Nullen in numerisch gleichen Konstanten. Die anderen Formelspalten sind textidentisch. Der Vergleich erfolgte am Formeltext und umfasst keine Neuberechnung in Excel.
- Die 621 JSON-Datensätze der Online-Ansicht stimmen mit der Generatorprojektion der v1.5-Arbeitsmappe überein. Alle 621 Detailseiten sind vorhanden. 72 Benchmarkstatus sind ausdrücklich offen. Für alle 621 NACE-Einträge nennt die Projektion Prüfbedarf zur Migration auf Rev. 2.1. NACE dient der Tätigkeitszuordnung und dem Screening. Indikator, SDG-Bezug und Tarifklasse brauchen eine eigene fallbezogene Zuordnung. [Eurostat](https://ec.europa.eu/eurostat/web/nace/)

## Vorgeschlagene Felder

| Datensatz | Schlüssel und Mindestinhalt |
| --- | --- |
| Produktprofil | product_id, profile_version, functional_unit, lifecycle_boundary, geography, observation_window, review_status |
| Indikatorbeleg | product_id, profile_version, item_id, register_version, rule_version, benchmark_version, source_status, method, unit, value, reference, observed_at, checked_at |
| Schutzprüfung | profile_version, protection_rule_ref, jurisdiction, applicability, protection_status, evidence_ref, reason, reviewed_at |
| Produktklassifizierung | profile_version, product_rule_ref, rmo_method_ref, final_score_status, tariff_class_status, valid_from, valid_to |
| Rechtliche Aktivierung | law_reference, legal_module_id, legal_effect_status, tariff_version, temporal_scope, taxable_event, applicable_area, remedy_reference |
| Prüfereignis | immutable_event_id, profile_version, actor_role, timestamp, before_ref, after_ref, reason |

Vor dem ersten Import eine Kopie des Registers mit Prüfsumme und Zeilenzahl sichern. Den Schlüssel `register_version + item_id` gegen das jeweilige Original prüfen. Die neuen Datensätze in einem separaten Namensraum erzeugen. Legacy-Exporte und Formeln werden bei der Erprobung weiter aus ihren bestehenden Quellen bedient. Für fehlende Werte ist `OFFEN` mit Begründung vorgesehen. `NICHT_ANWENDBAR` braucht eine begründete Anwendbarkeitsprüfung. Änderungen an Daten und Methoden erhalten neue Versionen und werden als Ereignis protokolliert.

Prüfen: IDs vor und nach dem Import identisch, kein Referenzbruch, Nullwert von leer unterscheidbar, mehrfacher Import idempotent, alte URLs/Exports auflösbar, Tarif- und Grenzwertänderungen zeitlich nachvollziehbar. Ein Modul bleibt ohne belastbaren Gesetzes- und Geltungsnachweis auf `NOT_IN_FORCE`. Bei gescheitertem Abgleich bleibt der bisherige Export die Referenz. Eine mögliche Rücknahme betrifft die ergänzenden Datensätze.
