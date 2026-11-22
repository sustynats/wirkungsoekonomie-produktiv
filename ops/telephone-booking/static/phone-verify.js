(() => {
  "use strict";
  // The fragment is never sent to the page server. Remove it before rendering
  // or contacting the API; retain the bearer only in this page's closure.
  const token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  const endpoint = "https://130.162.217.58.sslip.io/api/telephone-booking/verify/request";
  const validToken = /^[A-Za-z0-9_-]{40,80}$/.test(token);

  function start() {
    const message = document.getElementById("message");
    const details = document.getElementById("details");
    const identity = document.getElementById("identity");
    const confirmButton = document.getElementById("confirm");
    const dateFormat = new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin", dateStyle: "full", timeStyle: "short"
    });
    let pending = false;

    async function api(method = "GET") {
      const response = await fetch(endpoint, {
        method, mode: "cors", credentials: "omit", redirect: "error",
        referrerPolicy: "no-referrer", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) {
        if (response.status === 404) throw new Error("Dieser Bestätigungslink ist ungültig oder abgelaufen. Bitte frage einen neuen Termin an.");
        if (response.status === 409) throw new Error("Diese Anfrage kann nicht mehr bestätigt werden. Bitte frage einen neuen Termin an.");
        throw new Error("Die Anfrage konnte nicht geladen oder bestätigt werden. Bitte versuche es später erneut.");
      }
      const data = await response.json();
      if (!data || data.channel !== "phone" ||
          !["unverified", "pending", "confirmed", "declined", "cancelled", "expired"].includes(data.status) ||
          typeof data.start !== "string" || !Number.isFinite(Date.parse(data.start))) {
        throw new Error("Die Anfrage konnte nicht sicher zugeordnet werden. Bitte öffne den vollständigen Link aus deiner E-Mail.");
      }
      return data;
    }

    function render(data) {
      details.textContent = `${dateFormat.format(new Date(data.start))} Uhr (Europe/Berlin), 30 Minuten · Telefon`;
      identity.textContent = "Mit deinem Klick bestätigst du deine Gesprächsanfrage über den Link aus deinem Postfach.";
      confirmButton.hidden = data.status !== "unverified";
      message.textContent = data.status === "unverified"
        ? "Bitte bestätige deine Anfrage innerhalb von 72 Stunden. Erst danach erhält Natalie sie zur Prüfung."
        : data.status === "pending"
          ? "Deine Anfrage ist bestätigt. Natalie erhält sie jetzt zur persönlichen Prüfung und sagt innerhalb von 72 Stunden zu oder ab."
          : data.status === "confirmed"
            ? "Natalie hat deiner Anfrage zugesagt."
            : "Diese Anfrage ist abgeschlossen. Bitte frage bei Bedarf einen neuen Termin an.";
    }

    function failure(error) {
      // Only messages created here are used; fetch/JSON exception text may
      // contain transport details and is never reflected into the page.
      const safeMessages = new Set([
        "Dieser Bestätigungslink ist ungültig oder abgelaufen. Bitte frage einen neuen Termin an.",
        "Diese Anfrage kann nicht mehr bestätigt werden. Bitte frage einen neuen Termin an.",
        "Die Anfrage konnte nicht geladen oder bestätigt werden. Bitte versuche es später erneut.",
        "Die Anfrage konnte nicht sicher zugeordnet werden. Bitte öffne den vollständigen Link aus deiner E-Mail."
      ]);
      message.textContent = error instanceof Error && safeMessages.has(error.message)
        ? error.message
        : "Der Termindienst ist gerade nicht erreichbar. Bitte versuche es später erneut.";
    }

    confirmButton.addEventListener("click", async () => {
      if (pending || confirmButton.hidden) return;
      pending = true;
      confirmButton.disabled = true;
      try { render(await api("POST")); } catch (error) { failure(error); }
      finally { pending = false; confirmButton.disabled = false; }
    });
    if (!validToken || location.origin !== "https://wirkungsoekonomie.de") {
      message.textContent = "Bitte öffne den vollständigen Bestätigungslink aus deiner E-Mail.";
      return;
    }
    api().then(render).catch(failure);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
