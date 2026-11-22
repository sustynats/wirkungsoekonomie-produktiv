import fs from "node:fs";

const config = JSON.parse(fs.readFileSync(new URL("../../content/natalie/telephone-booking.json", import.meta.url), "utf8"));
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

export function telephoneBooking() {
  return `<section id="gespraech" class="band" aria-labelledby="booking-title">
    <div class="wrap booking">
      <p class="section-num">Persönlicher Kontakt</p>
      <h2 id="booking-title">Lass uns miteinander sprechen.</h2>
      <p class="lead-p">Du hast ein konkretes Anliegen? Frage ein 30-minütiges Telefongespräch oder, sofern freigeschaltet, einen Discord-Sprachanruf mit mir an.</p>
      <p>Dienstag, Mittwoch und Donnerstag zwischen 10:00 und 12:00 Uhr. Termine sind frühestens eine Woche und höchstens drei Kalendermonate im Voraus anfragbar. Alle Zeiten gelten für Deutschland (Europe/Berlin, mit Sommer-/Winterzeit).</p>
      <p>Vom 15. Dezember 2026 bis einschließlich 15. Januar 2027 sind keine Termine möglich.</p>
      <p><strong>Deine Anfrage ist noch keine Zusage.</strong> Bestätige sie zunächst innerhalb von 72 Stunden: bei Telefonanfragen per E-Mail-Link, bei Discord-Anfragen nach der Discord-Anmeldung mit einem eigenen Bestätigungsschritt. Bis zum Ablauf dieser Frist bleibt dein Termin für dich vorgemerkt. Danach prüfe ich dein Anliegen persönlich und antworte über den gewählten Kontaktweg. Die vorläufige Reservierung gilt anschließend höchstens 72 Stunden; ohne Zusage wird der Termin wieder frei.</p>
      <div data-booking data-endpoint="https://130.162.217.58.sslip.io/api/telephone-booking">
        <p data-booking-status role="status" aria-live="polite">Verfügbare Gesprächstermine werden geladen.</p>
        <button type="button" class="chip" data-booking-retry hidden>Termine erneut laden</button>
        <noscript><p>Für die Terminauswahl wird JavaScript benötigt. Ohne JavaScript kannst du über <a href="../../mitmachen.html">Kontakt</a> eine Anfrage stellen.</p></noscript>
        <form data-booking-form hidden>
          <fieldset>
            <legend>1. Wunschtermin auswählen</legend>
            <p>Wähle einen Tag und anschließend ein freies Zeitfenster.</p>
            <div class="booking-days" data-booking-days></div>
            <div class="booking-slots" data-booking-slots></div>
            <p data-booking-selection aria-live="polite">Noch kein Termin ausgewählt.</p>
          </fieldset>
          <fieldset>
            <legend>2. Deine Kontaktdaten</legend>
            <p>Alle Angaben sind Pflicht, sofern nicht ausdrücklich als freiwillig bezeichnet.</p>
            <div class="booking-grid">
              <label>Dein Name<input name="name" autocomplete="name" required minlength="2" maxlength="100"></label>
              <label>E-Mail-Adresse<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
              <label>Wie möchtest du sprechen?<select name="channel" required><option value="phone">Telefon</option><option value="discord">Discord-Sprachanruf (nur Audio)</option></select></label>
              <label data-phone-label>Telefonnummer (mit Ländervorwahl)<input name="phone" type="tel" autocomplete="tel" required maxlength="40" placeholder="+49 …"></label>
              <label data-discord-label hidden>Discord-Benutzername (nicht der Anzeigename)<input name="discord" autocomplete="off" minlength="2" maxlength="32" placeholder="dein.benutzername" disabled><span class="booking-hint">Im nächsten Schritt prüfst du deinen Account durch die Anmeldung bei Discord. Dabei wird der aktuelle Benutzername übernommen.</span></label>
              <label>Bestätigung erhalten per<select name="replyVia" required><option value="email">E-Mail</option><option value="discord" disabled>Discord</option></select></label>
            </div>
          </fieldset>
          <fieldset>
            <legend>3. Dein Anliegen und deine Vorfragen</legend>
            <label>Was ist der Anlass?<select name="topic" required><option value="">Bitte auswählen</option>${config.topics.map(({ id, label }) => `<option value="${esc(id)}">${esc(label)}</option>`).join("")}</select></label>
            ${config.questions.map(({ id, label, hint, minLength, maxLength }) => `<label for="booking-${id}">${esc(label)}</label><p id="booking-${id}-hint" class="booking-hint">${esc(hint)}</p><textarea id="booking-${id}" name="${id}" required minlength="${minLength}" maxlength="${maxLength}" rows="4" aria-describedby="booking-${id}-hint"></textarea>`).join("\n")}
          </fieldset>
          <div class="booking-trap" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
          <p class="booking-hint">Deine Angaben werden zur Bearbeitung der Anfrage privat gespeichert. Nach deiner Bestätigung erhalte ich eine Privatnachricht über meinen Discord-Bot mit deinem Namen, der Anlasskategorie, einem kurzen Auszug deines Anliegens und einem geschützten Link zu deiner Anfrage. Für Telefonanfragen brauchst du kein eigenes Discord-Konto. Bei einem Discord-Gespräch prüfst du deinen Account über Discord; dabei werden Benutzername und Nutzer-ID übernommen. Bei bestätigten Terminen können Name, Kontaktweg und Gesprächsanlass in meinem privaten iCloud-Kalender stehen. Bitte übermittle keine vertraulichen Unterlagen oder sensiblen Angaben über Dritte. Unbestätigte Anfragen werden beim regulären Bereinigungslauf gelöscht, sobald nach Ablauf der Bestätigungsfrist ein weiterer Tag vergangen ist; bestätigte Buchungsdaten planmäßig 30 Tage nach dem Termin beziehungsweise nach Abschluss der Anfrage. Bei einer ungeklärten Kalenderübertragung bleiben die betroffenen Daten vorerst zur Klärung gespeichert. Nachrichten in Discord oder E-Mail und Kalendereinträge werden getrennt verwaltet. Für bestätigte Gespräche führe ich zusätzlich einen privaten Kontakt- und Gesprächsverlauf mit Kontaktdaten, Anliegen, Terminen, gegebenenfalls öffentlich angegebenen beruflichen Tätigkeiten samt Profilquelle und meinen Gesprächsnotizen. Er hilft mir bei der Vorbereitung und Wiedererkennung von Anschlussterminen und wird getrennt von den technischen Buchungsdaten verwaltet. <a href="../../datenschutz.html#terminbuchung">Datenschutzhinweise zur Terminanfrage und Kontakt</a>.</p>
          <label class="booking-consent"><input type="checkbox" name="acknowledged" required> Ich habe die Hinweise gelesen und weiß, dass der Termin erst mit Natalies persönlicher Bestätigung verbindlich wird.</label>
          <button type="submit" class="btn btn-primary" data-booking-submit disabled>Gesprächstermin anfragen</button>
          <p data-booking-result role="status" aria-live="polite" tabindex="-1"></p>
          <p data-booking-next hidden><a class="btn btn-primary">Discord-Account prüfen und Anfrage bestätigen</a></p>
        </form>
      </div>
    </div>
  </section>`;
}
