const endpoint = "/api/telephone-booking/manage";
const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const message = document.getElementById("message");
const dateFormat = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "full", timeStyle: "short" });
const stateLabels = { unverified: "Noch nicht bestätigt", pending: "Offene Anfrage", confirmed: "Zugesagt", declined: "Abgelehnt", cancelled: "Abgesagt", expired: "Vorläufige Reservierung abgelaufen" };
let current;
let working = false;

async function api(path, payload) {
  const response = await fetch(endpoint + path, {
    method: payload ? "POST" : "GET", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error((await response.json()).error || "Die Anfrage ist fehlgeschlagen.");
  return response;
}

function render(data) {
  current = data;
  const p = data.payload;
  const calendarHeld = typeof data.calendarState === "string" && data.calendarState.endsWith("_hold");
  const emailPending = ["queued", "unknown"].includes(data.confirmationDelivery);
  document.getElementById("detail").hidden = false;
  document.getElementById("title").textContent = `${p.name} · ${dateFormat.format(new Date(p.start))} Uhr`;
  const fields = document.getElementById("fields");
  fields.replaceChildren();
  for (const [label, value] of [["Anfragenummer", data.reference], ["Prüfung des Kontaktwegs", data.discordVerified ? `Discord-Account geprüft (ID ${p.discordId}). E-Mail-Adresse nicht separat verifiziert.` : data.verified ? "E-Mail-Adresse durch Bestätigungslink verifiziert." : "Noch nicht verifiziert."], ["Gesprächsweg", p.channel === "phone" ? "Telefon" : "Discord-Sprachanruf (nur Audio)"], ["Kontakt", p.phone || p.discord], ["E-Mail", p.email], ["Gewünschte Antwort", p.replyVia === "email" ? "E-Mail" : "Discord"], ["Anlass", p.topic], ["Hintergrund", p.background], ["Vorfragen", p.questions], ["Gewünschtes Ergebnis", p.outcome]]) {
    const dt = document.createElement("dt"); const dd = document.createElement("dd");
    dt.textContent = label; dd.textContent = value; fields.append(dt, dd);
  }
  const replyState = data.confirmationDelivery === "queued" ? "E-Mail wartet auf Versand." : data.confirmationDelivery === "unknown" ? "Versandstatus ungeklärt. Bitte persönlich prüfen; nicht erneut senden." : data.confirmationSent ? "Persönliche Antwort als versandt markiert." : "Noch keine persönliche Antwort als versandt markiert.";
  document.getElementById("state").textContent = calendarHeld ? "Kalenderaktion ungeklärt. Bitte persönlich prüfen, bevor du antwortest oder einen Kalendereintrag änderst." : `${stateLabels[data.status]}. ${data.status === "pending" ? `Reserviert bis ${dateFormat.format(new Date(data.expires))} Uhr.` : ""} ${replyState}`;
  document.getElementById("calendar-state").textContent = calendarHeld ? "Der Kalenderzustand ist nicht bestätigt. Der Termin bleibt vorsorglich reserviert; keine Aktion wird automatisch wiederholt." : data.calendarState === "synced" ? "Der Termin ist im iCloud-Kalender Nats eingetragen (Erinnerungen: 24 Stunden und 30 Minuten vorher)." : data.status === "confirmed" ? "iCloud ist nicht automatisch angebunden. Die Kalenderdatei kannst du in Nats importieren." : "Kalendereintrag erst nach deiner Zusage.";
  document.querySelector('[data-action="approve"]').hidden = calendarHeld || data.status !== "pending";
  document.querySelector('[data-action="decline"]').hidden = calendarHeld || data.recoveryRequired || data.status !== "pending";
  document.querySelector('[data-action="cancel"]').hidden = calendarHeld || emailPending || data.status !== "confirmed";
  document.getElementById("reply").hidden = calendarHeld || !["confirmed", "declined", "cancelled"].includes(data.status);
  document.getElementById("download").hidden = calendarHeld || data.status !== "confirmed" || data.calendarState === "synced";
  document.querySelector('[data-action="sent"]').hidden = calendarHeld || emailPending || Boolean(data.confirmationSent) || (["confirmed", "declined", "cancelled"].includes(data.status) && p.replyVia === "email");
  const when = `${dateFormat.format(new Date(p.start))} Uhr (Europe/Berlin), 30 Minuten`;
  const body = `Hallo ${p.name},\n\n${data.status === "confirmed" ? `hiermit bestätige ich unser Gespräch am ${when}.\n${p.channel === "phone" ? `Ich rufe dich unter ${p.phone} an.` : `Wir sprechen per Discord-Sprachanruf (nur Audio). Dein Benutzername: ${p.discord}. Bitte stelle sicher, dass ich dich dort erreichen kann.`}\nFalls du verhindert bist, gib mir bitte über diesen Kontaktweg Bescheid.` : data.status === "cancelled" ? `leider muss ich unseren Gesprächstermin am ${when} absagen.` : `vielen Dank für deine Anfrage. Den gewünschten Gesprächstermin am ${when} kann ich leider nicht zusagen.`}\n\nViele Grüße\nNatalie Weber`;
  const directEmail = ["confirmed", "declined", "cancelled"].includes(data.status) && p.replyVia === "email" && data.confirmationPreview;
  document.getElementById("draft").value = data.confirmationPreview ? data.confirmationPreview.body : body;
  const participantCalendar = !calendarHeld && data.status === "confirmed" && typeof data.confirmationPreview?.calendar?.ics === "string";
  document.getElementById("participant-download").hidden = !participantCalendar;
  document.getElementById("participant-calendar-info").hidden = !participantCalendar;
  document.getElementById("copy").hidden = Boolean(directEmail) || emailPending;
  const email = document.getElementById("email");
  email.hidden = calendarHeld || p.replyVia !== "email" || Boolean(directEmail);
  email.href = `mailto:${encodeURIComponent(p.email)}?subject=${encodeURIComponent(`Gesprächsanfrage ${data.reference}: ${stateLabels[data.status]}`)}&body=${encodeURIComponent(body)}`;
  const send = document.querySelector('[data-action="send_confirmation_email"]');
  send.hidden = calendarHeld || emailPending || !directEmail || Boolean(data.confirmationSent);
  send.textContent = data.status === "confirmed" ? "Terminbestätigung per E-Mail senden" : "Absage per E-Mail senden";
  const preview = document.getElementById("email-preview");
  preview.hidden = !directEmail;
  preview.textContent = directEmail ? `Empfänger: ${data.confirmationPreview.email} · Betreff: ${data.confirmationPreview.subject} · Termin: ${when}` : "";
  document.getElementById("reply-info").textContent = directEmail ? "Prüfe Empfänger und Text. Erst der Senden-Button beauftragt die E-Mail über das Buchungspostfach." : "Sende deine Antwort persönlich über den gewählten Kontaktweg.";
  message.textContent = calendarHeld ? "Die letzte Kalenderaktion muss persönlich geprüft werden. Bitte nicht wiederholen und noch keine Bestätigung oder Absage versenden." : emailPending ? replyState : "Anfrage geladen. Zusagen und Absagen ändern den Terminstatus; die persönliche Nachricht versendest du anschließend selbst.";
}

function lockUnknownCalendarView() {
  for (const action of ["approve", "decline", "cancel", "sent", "send_confirmation_email"]) {
    document.querySelector(`[data-action="${action}"]`).hidden = true;
  }
  for (const id of ["reply", "download", "email", "participant-download", "participant-calendar-info"]) document.getElementById(id).hidden = true;
  document.getElementById("state").textContent = "Der aktuelle Status ist ungeklärt.";
  document.getElementById("calendar-state").textContent = "Bitte zuerst den Status erneut laden und persönlich prüfen. Keine Kalenderaktion wiederholen.";
}

async function run(action) {
  if (working) return;
  if (action === "cancel" && !confirm("Diesen bereits zugesagten Termin absagen? Den Kontakt musst du anschließend persönlich informieren.")) return;
  if (action === "decline" && !confirm("Diese Anfrage ablehnen und das Zeitfenster freigeben?")) return;
  if (action === "send_confirmation_email" && !confirm(`Die angezeigte ${current.status === "confirmed" ? "Terminbestätigung" : "Absage"} an ${current.confirmationPreview.email} senden?`)) return;
  working = true;
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  message.textContent = "Anfrage wird verarbeitet …";
  try {
    const payload = action ? { action, ...(action === "send_confirmation_email" ? { expectedStatus: current.status } : {}) } : undefined;
    render(await (await api("/request", payload)).json());
  } catch (error) {
    lockUnknownCalendarView();
    message.textContent = "Der Status konnte nicht sicher gelesen werden. Bitte zuerst aktualisieren und prüfen; keine Antwort versenden und keine Kalenderaktion wiederholen.";
  } finally {
    working = false;
    document.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}
document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => run(button.dataset.action)));
document.getElementById("reload").addEventListener("click", () => run());
document.getElementById("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(document.getElementById("draft").value); message.textContent = "Antworttext kopiert. Bitte persönlich versenden."; }
  catch { message.textContent = "Bitte den Text im Feld markieren und kopieren."; }
});
document.getElementById("participant-download").addEventListener("click", () => {
  const calendarHeld = typeof current?.calendarState === "string" && current.calendarState.endsWith("_hold");
  const ics = current?.confirmationPreview?.calendar?.ics;
  if (working || document.getElementById("participant-download").hidden || calendarHeld || current?.status !== "confirmed" || typeof ics !== "string") return;
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "gespraech-natalie-weber.ics"; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  message.textContent = "Kalenderdatei für den Kontakt heruntergeladen. Du kannst sie persönlich zusammen mit deiner Bestätigung weitergeben.";
});
document.getElementById("download").addEventListener("click", async () => {
  try {
    const blob = await (await api("/calendar.ics")).blob();
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "gespraech-nats.ics"; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) { message.textContent = error.message; }
});
if (token) run();
else message.textContent = "Bitte öffne den privaten Verwaltungslink aus deiner Discord-Nachricht erneut.";
