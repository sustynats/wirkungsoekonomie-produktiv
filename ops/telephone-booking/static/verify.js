const endpoint = "/api/telephone-booking";
const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const message = document.getElementById("message");
const confirmButton = document.getElementById("confirm");
const discordButton = document.getElementById("discord");
const dateFormat = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "full", timeStyle: "short" });
async function api(path, method = "GET") {
  const response = await fetch(endpoint + path, { method, cache: "no-store", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}), signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Bitte versuche es später erneut.");
  return data;
}
function render(data) {
  document.getElementById("details").textContent = `${dateFormat.format(new Date(data.start))} Uhr (Europe/Berlin), 30 Minuten · ${data.channel === "phone" ? "Telefon" : "Discord-Sprachanruf"}`;
  const unverified = data.status === "unverified";
  discordButton.hidden = !unverified || data.channel !== "discord" || data.discordVerified;
  confirmButton.hidden = !unverified || (data.channel === "discord" && !data.discordVerified);
  document.getElementById("identity").textContent = data.discordVerified ? `Dein Discord-Account wurde geprüft: @${data.discord}. Dieser Account wird für dein Gespräch verwendet. Bitte ermögliche persönliche Nachrichten und Sprachanrufe.` : data.channel === "discord" ? "Melde dich bei Discord an, damit dein tatsächlicher Benutzername und deine Nutzer-ID überprüft werden können. Es werden keine Nachrichten oder Serverlisten ausgelesen." : "Mit dem Bestätigungslink weist du den Zugriff auf die angegebene E-Mail-Adresse nach.";
  message.textContent = unverified ? "Bitte bestätige deine Anfrage innerhalb von 72 Stunden nach dem Absenden." : data.status === "pending" ? "Deine Anfrage ist bestätigt und wird Natalie zur Prüfung zugestellt. Bitte warte auf ihre persönliche Zusage. Ohne Zusage wird die Reservierung nach spätestens 72 Stunden aufgehoben." : data.status === "confirmed" ? "Natalie hat diesem Termin zugestimmt. Die persönliche Bestätigung erhältst du über den vereinbarten Kontaktweg." : "Diese Anfrage ist abgeschlossen. Bei Bedarf kannst du einen neuen Termin anfragen.";
}
confirmButton.addEventListener("click", async () => {
  confirmButton.disabled = true;
  try { render(await api("/verify/request", "POST")); }
  catch (error) { message.textContent = error.message; }
  finally { confirmButton.disabled = false; }
});
discordButton.addEventListener("click", async () => {
  discordButton.disabled = true;
  try { const data = await api("/discord/start", "POST"); location.assign(data.url); }
  catch (error) { message.textContent = error.message; discordButton.disabled = false; }
});
if (token) api("/verify/request").then(render).catch((error) => { message.textContent = error.message; });
else message.textContent = "Bitte öffne den vollständigen Bestätigungslink aus deiner E-Mail oder aus der Terminanfrage erneut.";
