const root = document.querySelector("[data-booking]");
if (root) {
  const form = root.querySelector("form");
  const status = root.querySelector("[data-booking-status]");
  const result = root.querySelector("[data-booking-result]");
  const retry = root.querySelector("[data-booking-retry]");
  const submit = root.querySelector("[data-booking-submit]");
  const days = root.querySelector("[data-booking-days]");
  const times = root.querySelector("[data-booking-slots]");
  const selection = root.querySelector("[data-booking-selection]");
  const endpoint = root.dataset.endpoint;
  const discordOption = form.elements.channel.querySelector('[value="discord"]');
  const discordOptionLabel = discordOption.textContent;
  const dayFormat = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit" });
  const timeFormat = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
  let selected = null;
  let requestId = crypto.randomUUID();
  let sending = false;
  let completed = false;
  let discordSupported = false;

  function button(label, action) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.setAttribute("aria-pressed", "false");
    el.addEventListener("click", () => { if (!sending) action(el); });
    return el;
  }
  function resetSelection() {
    selected = null;
    submit.disabled = true;
    selection.textContent = "Noch kein Termin ausgewählt.";
  }
  function updateChannel() {
    if (!discordSupported && form.elements.channel.value === "discord") form.elements.channel.value = "phone";
    const discord = form.elements.channel.value === "discord";
    root.querySelector("[data-phone-label]").hidden = discord;
    root.querySelector("[data-discord-label]").hidden = !discord;
    form.elements.phone.required = !discord;
    form.elements.phone.disabled = discord;
    form.elements.discord.required = discord;
    form.elements.discord.disabled = !discord;
    form.elements.replyVia.querySelector('[value="discord"]').disabled = !discord;
    if (!discord) form.elements.replyVia.value = "email";
  }
  function applySupportedChannels(channels) {
    discordSupported = Array.isArray(channels) && channels.includes("discord");
    discordOption.disabled = !discordSupported;
    discordOption.textContent = discordSupported ? discordOptionLabel : "Discord-Sprachanruf (derzeit nicht verfügbar)";
    updateChannel();
  }
  async function load() {
    retry.hidden = true;
    form.hidden = true;
    resetSelection();
    status.textContent = "Verfügbare Gesprächstermine werden geladen.";
    try {
      const response = await fetch(`${endpoint}/slots`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!Array.isArray(data.slots)) throw new Error();
      applySupportedChannels(data.supportedChannels);
      days.replaceChildren();
      times.replaceChildren();
      const groups = new Map();
      for (const slot of data.slots) {
        if (!groups.has(slot.date)) groups.set(slot.date, []);
        groups.get(slot.date).push(slot);
      }
      for (const slots of groups.values()) {
        days.append(button(dayFormat.format(new Date(slots[0].start)), (dayButton) => {
          days.querySelectorAll("button").forEach((el) => el.setAttribute("aria-pressed", String(el === dayButton)));
          resetSelection();
          times.replaceChildren(...slots.map((slot) => button(`${timeFormat.format(new Date(slot.start))}–${timeFormat.format(new Date(slot.end))}`, (slotButton) => {
            selected = slot.start;
            times.querySelectorAll("button").forEach((el) => el.setAttribute("aria-pressed", String(el === slotButton)));
            selection.textContent = `Dein Wunschtermin: ${dayFormat.format(new Date(slot.start))}, ${timeFormat.format(new Date(slot.start))}–${timeFormat.format(new Date(slot.end))} Uhr (Europe/Berlin).`;
            submit.disabled = false;
          })));
        }));
      }
      status.textContent = data.slots.length ? "Freie Zeitfenster für deine Anfrage:" : "Derzeit sind keine Gesprächstermine frei. Bitte versuche es später erneut.";
      form.hidden = !data.slots.length;
      retry.hidden = Boolean(data.slots.length);
    } catch {
      status.textContent = "Die Terminanfrage ist derzeit nicht verfügbar. Bitte versuche es später erneut.";
      retry.hidden = false;
    }
  }
  form.elements.channel.addEventListener("change", updateChannel);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending || completed || !selected || !form.reportValidity()) return;
    sending = true;
    submit.disabled = true;
    result.textContent = "Deine Anfrage wird übermittelt …";
    const payload = Object.fromEntries(new FormData(form));
    payload.start = selected;
    payload.requestId = requestId;
    payload.acknowledged = form.elements.acknowledged.checked;
    try {
      const response = await fetch(`${endpoint}/requests`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) { requestId = crypto.randomUUID(); await load(); }
        throw new Error(data.error || "Die Anfrage konnte nicht übermittelt werden.");
      }
      completed = true;
      result.textContent = data.status !== "unverified" ? `Deine bereits bestätigte Anfrage (Nr. ${data.reference}) liegt vor. Bitte warte auf Natalies persönliche Antwort.` : data.verification === "discord" ? `Deine Anfrage ist vorgemerkt (Nr. ${data.reference}). Prüfe jetzt deinen Discord-Account und bestätige die Anfrage innerhalb von 72 Stunden. Erst danach erhält Natalie sie zur Prüfung.` : `Deine Anfrage ist vorgemerkt (Nr. ${data.reference}). Du erhältst eine E-Mail mit Bestätigungslink. Bitte bestätige deine Anfrage innerhalb von 72 Stunden und prüfe gegebenenfalls deinen Spamordner. Erst danach erhält Natalie sie zur Prüfung.`;
      if (data.verificationUrl) {
        const next = root.querySelector("[data-booking-next]");
        next.querySelector("a").href = data.verificationUrl;
        next.hidden = false;
      }
      form.querySelectorAll("fieldset, .booking-consent, [data-booking-submit]").forEach((el) => { el.hidden = true; });
      result.focus();
    } catch (error) {
      result.textContent = error.name === "TimeoutError" || error instanceof TypeError ? "Die Verbindung wurde unterbrochen. Du kannst dieselbe Anfrage erneut senden; sie wird nicht doppelt angelegt." : error.message;
      result.focus();
    } finally {
      sending = false;
      submit.disabled = completed || !selected;
    }
  });
  retry.addEventListener("click", load);
  applySupportedChannels(null);
  load();
}
