# Discord-Veröffentlichungen

Stand 22. November 2026. Führende Websitequelle ist `sustynats/wirkungsoekonomie-produktiv`. Der vorhandene Oracle-Bot liest ausschließlich die kanonischen Website-Feeds; ein Repositorywechsel ändert diese Feed-Adressen nicht.

## Betrieb

`WOEK_DISCORD_PUBLISHER_MODE=oracle_bot` im Produktionsrepository unterdrückt den parallelen GitHub-Webhook-Versand. Die Actions des alten Website-Repositorys bleiben deaktiviert. Der Bot veröffentlicht Journal, Podcast, Bibliothek, öffentlichen Wirkungsraum, Neuigkeiten und Meinung & Analyse einschließlich der dort freigegebenen redaktionellen Formate. Kanalzuordnungen, Zugangsdaten und Versandzustand bleiben privat auf Oracle.

Der Patch ergänzt die Feed-Schlüssel `analyse` und `neuigkeiten` sowie `WEBSITE_FEED_ANALYSE_CHANNEL_ID` und `WEBSITE_FEED_NEUIGKEITEN_CHANNEL_ID`. Bestehende Routen bleiben erhalten. Einen entfernten Zielkanal auf einen bestehenden passenden Kanal abbilden; keine Inhalte oder fremden Nachrichten löschen.

## Zustandsmigration und Dublettenschutz

Version 2 verwendet Kanal-ID plus Beitrags-URL statt wechselnder Feed-GUIDs. Frühere `seenIds` bleiben vollständig als `legacySeenIds` erhalten. Die erste geprüfte Feedaufnahme bildet bei deaktiviertem `POST_EXISTING_ON_FIRST_RUN` eine ausdrücklich dokumentierte Baseline und versendet keine historischen Beiträge erneut. Eine Baseline ist kein behaupteter Zustellnachweis.

Vor jedem Versand wird eine Reservierung atomar gespeichert. Jeder bestätigte Versand wird unmittelbar gesichert; spätere Fehler können frühere Meldungen nicht erneut auslösen. Eindeutige HTTP-Ablehnungen geben nur die betroffene Reservierung frei und blockieren andere Routen nicht. Unklare Versandausgänge bleiben zur gezielten Klärung als `pending` erhalten und werden nicht blind wiederholt. Eine stabile Discord-Nonce ergänzt diesen Schutz für kurzfristige Wiederholungen.

Identitäten werden nicht mehr nach 500 oder 1000 Einträgen abgeschnitten. Eine beschädigte Zustandsdatei stoppt den Versand, statt die Historie zurückzusetzen. Ein automatischer historischer Backfill ist nicht Bestandteil der Umstellung.

## Geprüfter Rollout

Originalcode, private Konfiguration und Zustand wurden vor dem gezielten Austausch auf Oracle gesichert. Es wurden nur Publisher, Routen-Konfiguration und die benötigten Bot-Schreibrechte geändert. Keine Administratorrechte vergeben. Ein lesend bestätigter Verbindungstest wurde anschließend gelöscht. Die privaten Wiederherstellungsbelege bleiben außerhalb des öffentlichen Repositorys.

Die ergänzten Tests prüfen Reservierung vor Versand, unmittelbare Bestätigung, Kanaltrennung, abgelehnte und unklare Zustellungen, mehr als 500 Einträge, Migration ohne Rückversand und das Stoppen bei beschädigtem Zustand. Im bestehenden Botprojekt die beigefügten Tests neben den vorhandenen Parserprüfungen ausführen und die zwei betroffenen TypeScript-Module kompilieren. Den gesamten alten Deploy-Sammelbefehl dafür nicht erneut ausführen.
