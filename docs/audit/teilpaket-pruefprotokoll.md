# Prüfprotokoll zum T-Shirt- und Steuerentwurf

| Prüfung | Ergebnis |
| --- | --- |
| Rechen- und Statusregressionen | 76 von 76 Node-Tests erfolgreich. Acht neue Tests prüfen offene Daten, NACE, Schutzgrenze, Personenausschluss, Versionsnachweis, Tarif- und USt-Szenarien, dreistufige Anrechnung sowie Einfuhr und Ausfuhr. Die Buchabbildung zur früheren Demo hat einen eigenen Bestandstest. |
| Desktop und Mobil | Lokal in Chrome bei 1440 × 1000 und 390 × 844. Selektoren, Tastaturfokus, zugängliche Namen, Ergebniswechsel, Details und fehlender horizontaler Überlauf geprüft. Kein vollständiges WCAG-Audit. Vorher-/Nachher-Aufnahmen liegen im lokalen Ergebnisordner. |
| Ausgangspunkt | Vorher-Ansicht aus dem geprüften Checkout. Live-Crawl und Deployment-Beleg sind in der Inventur dokumentiert. |
| Rechtsvarianten | Fiktiver Tarif, echte Umsatzsteuer als Bezugsgröße, separate Abgabenbasis, Rundung, Preisweitergabe und Eingangsanrechnung getestet. Rechtliche Aktivierung, Einfuhr/Export sowie die fallbezogene Grenzwertanwendung bleiben offen. |
| Browser-Suchindex | Generator lokal ausgeführt. Die erzeugten Indexdateien sind Bestandteil des Website-Entwurfs. |
| Veröffentlichung | Bestehenden Live-Stand geprüft. Der Website-Entwurf befindet sich im Pull Request. |

Lokale Regressionen: `node --test tests/site/two-shirts-*.cjs tests/site/two-shirts-revision.test.mjs`.

## Regressionen zu Produktdemos und Referenzseiten

- Erleben-Tests 19 von 19 und T-Shirt-Revision 9 von 9 bestanden. Der Produktrechner trennt leere und ungültige Eingaben von einer gültigen Null. Das Schutzsignal bleibt bei einer angenommenen schweren Verletzung blockiert. Ein Aufschlag von 10 % auf 0,05 Euro ergibt nach Cent-Rundung 0,06 Euro.
- Chrome bei 390 und 1440 Pixeln. Preis-Testannahme, offene Felder, Lieferantenvorwahl und direkte Links zu § 66 und § 78 geprüft. Die Rechner-Screenshots liegen im lokalen Ergebnisordner. Das ist eine Funktions- und Geräteprüfung. Ein vollständiges Barrierefreiheitsaudit bleibt offen.
- WÖMS-Registry 152 Methoden, 56 Varianten und 208 Canvas-Spezifikationen. Glossarprüfung 2.161 Begriffe. T-SROI-Standardprüfung für drei Studienskripte und 19.316 indexierbare Seiten. Die Werkzeuge prüfen die jeweiligen strukturellen oder terminologischen Anforderungen.
