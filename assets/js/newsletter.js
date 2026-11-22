(() => {
  const apiOrigin = "https://130.162.217.58.sslip.io";
  const landing = document.querySelector("[data-woek-newsletter-landing]");
  const root = document.querySelector("[data-woek-newsletter]");
  const relayHosts = new Set(["wirkungsoekonomie.de", "www.wirkungsoekonomie.de", "parlament.wirkungsoekonomie.de"]);

  function parameters() {
    return new URLSearchParams(window.location.search);
  }

  function cleanAddress() {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  function setupLanding() {
    if (!(landing instanceof HTMLElement)) return false;
    const action = landing.dataset.woekNewsletterLanding;
    const button = landing.querySelector("[data-woek-newsletter-landing-action]");
    const message = landing.querySelector("[data-woek-newsletter-landing-message]");
    if (!(button instanceof HTMLButtonElement) || !(message instanceof HTMLElement)) return true;
    let locked = false;
    let query;
    const isBackend = window.location.hostname === "130.162.217.58.sslip.io" || window.location.hostname === "woek-parlament.vercel.app";
    try {
      if (action !== "confirm" && action !== "unsubscribe") throw new Error("Ungültiger Vorgang.");
      if (!isBackend && !relayHosts.has(window.location.hostname)) throw new Error("Dieser Vorgang ist auf dieser Website nicht verfügbar.");
      const input = parameters();
      if (input.has("delivery")) throw new Error("Dieser Abmeldelink gehört zu einem anderen Versandweg. Bitte wenden Sie sich an uns; eine Abmeldung wurde noch nicht durchgeführt.");
      query = new URLSearchParams();
      const fields = action === "confirm" ? ["subscription", "token", "unsubscribe_token"] : ["subscription", "token"];
      for (const name of fields) {
        const values = input.getAll(name);
        if (name === "unsubscribe_token" && values.length === 0) continue;
        const value = values[0] || "";
        const valid = name === "subscription" ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) : /^[A-Za-z0-9_-]{43}$/.test(value);
        if (values.length !== 1 || !valid) throw new Error("Dieser Link ist unvollständig oder ungültig. Bitte öffnen Sie den vollständigen Link aus Ihrer E-Mail.");
        query.set(name, value);
      }
    } catch (error) {
      button.disabled = true;
      message.textContent = error.message;
      message.classList.add("is-error");
      return true;
    }
    if (!isBackend) {
      button.textContent = action === "confirm" ? "Weiter zur sicheren Bestätigung" : "Weiter zur sicheren Abmeldung";
      message.textContent = "Öffnen Sie die sichere Seite. Erst dort bestätigen Sie den Vorgang mit einem weiteren Klick.";
    }
    button.addEventListener("click", async () => {
      if (locked) return;
      locked = true;
      button.disabled = true;
      message.classList.remove("is-error");
      const route = action === "confirm" ? "bestaetigen" : "abmelden";
      if (!isBackend) {
        try {
          const link = document.createElement("a");
          link.href = `${apiOrigin}/woek-newsletter/${route}?${query}`;
          link.referrerPolicy = "no-referrer";
          document.body.appendChild(link);
          link.click();
          link.remove();
          message.textContent = "Sie werden zur sicheren Seite weitergeleitet. Dort führen Sie den Vorgang mit einem weiteren Klick aus.";
        } catch {
          locked = false;
          button.disabled = false;
          message.textContent = "Die sichere Seite konnte nicht geöffnet werden. Bitte versuchen Sie es erneut.";
          message.classList.add("is-error");
        }
        return;
      }
      let definitiveRejection = false;
      message.textContent = action === "confirm" ? "Ihre Anmeldung wird bestätigt …" : "Ihre Abmeldung wird verarbeitet …";
      try {
        const response = await fetch(`/api/woek-newsletter/${route}`, {
          method: "POST", credentials: "same-origin", referrerPolicy: "no-referrer",
          headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(query))
        });
        const result = await response.json();
        if (!response.ok) {
          definitiveRejection = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
          throw new Error(result.error || "Der Link konnte nicht verarbeitet werden.");
        }
        const valid = action === "confirm" ? result.outcome === "confirmed" || result.outcome === "already_active" : result.outcome === "unsubscribed";
        if (!valid) throw new Error("unrecognised outcome");
        landing.dataset.state = "complete";
        button.hidden = true;
        message.textContent = action === "confirm" ? "Ihre Anmeldung zum Wirkungsbrief ist bestätigt." : "Ihre Abmeldung vom Wirkungsbrief ist bestätigt.";
        cleanAddress();
      } catch (error) {
        message.textContent = definitiveRejection ? error.message : "Wir konnten keine sichere Rückmeldung erhalten. Bitte prüfen Sie Ihr Postfach oder wenden Sie sich an uns, bevor Sie es erneut versuchen.";
        message.classList.add("is-error");
        if (definitiveRejection) { locked = false; button.disabled = false; }
      }
    });
    return true;
  }

  if (setupLanding() || !(root instanceof HTMLElement)) return;

  const form = root.querySelector("[data-woek-newsletter-form]");
  const message = root.querySelector("[data-woek-newsletter-message]");
  const welcome = root.querySelector("[data-woek-newsletter-welcome]");
  const controls = Array.from(document.querySelectorAll("[data-woek-newsletter-control]"));
  let signupAvailable = false;
  let signupUncertain = false;
  let signupPending = false;
  let signupComplete = false;

  function setMessage(text, isError = false) {
    if (!(message instanceof HTMLElement)) return;
    message.textContent = text;
    message.classList.toggle("is-error", isError);
  }

  function setSignupAvailable(available) {
    signupAvailable = available;
    if (!(form instanceof HTMLFormElement)) return;
    const submit = form.querySelector("button[type='submit']");
    if (submit instanceof HTMLButtonElement) submit.disabled = !available || signupUncertain || signupPending || signupComplete;
  }

  function updateControls(state) {
    const active = state === "active";
    root.dataset.newsletterState = state;
    if (form instanceof HTMLFormElement) form.hidden = active;
    if (welcome instanceof HTMLElement) welcome.hidden = !active;
    controls.forEach((control) => {
      if (!(control instanceof HTMLButtonElement)) return;
      control.classList.toggle("is-active", active);
      control.textContent = active ? "Willkommen zurück" : (control.dataset.newsletterLabel || "Newsletter");
      control.setAttribute("aria-label", active ? "Der Wirkungsbrief ist aktiv" : "Der Wirkungsbrief anmelden");
    });
  }

  function showSignup() {
    updateControls("unknown");
    root.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => root.querySelector("input[name='email']")?.focus(), 420);
  }

  controls.forEach((control) => control.addEventListener("click", showSignup));

  async function loadState() {
    try {
      const response = await fetch(`${apiOrigin}/api/woek-newsletter`, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error("Newsletter status unavailable");
      const data = await response.json();
      setSignupAvailable(data.signup_available === true);
      // The existing backend cannot set the website cookie from its Vercel hostname.
      updateControls("unknown");
      if (!signupAvailable && form instanceof HTMLFormElement && !form.hidden) {
        setMessage("Die Anmeldung zum Wirkungsbrief ist derzeit nicht erreichbar. Bitte versuchen Sie es später erneut.", true);
      }
    } catch {
      setSignupAvailable(false);
      updateControls("unknown");
      setMessage("Die Anmeldung zum Wirkungsbrief ist derzeit nicht erreichbar. Bitte versuchen Sie es später erneut.", true);
    }
  }

  if (form instanceof HTMLFormElement) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!signupAvailable || signupUncertain || signupPending || signupComplete || !form.reportValidity()) return;
      const submit = form.querySelector("button[type='submit']");
      if (!(submit instanceof HTMLButtonElement)) return;
      signupPending = true;
      const values = new FormData(form);
      submit.disabled = true;
      setMessage("Die Bestätigungs-E-Mail wird vorbereitet …");
      let definitiveRejection = false;
      try {
        const response = await fetch(`${apiOrigin}/api/woek-newsletter`, {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: values.get("email"),
            consent: values.get("consent") === "on",
            consent_source: "wirkungsoekonomie.de/",
            website: values.get("website")
          })
        });
        const result = await response.json();
        if (!response.ok) {
          definitiveRejection = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
          throw new Error(result.error || "Die Newsletter-Anmeldung konnte nicht verarbeitet werden.");
        }
        if (result.outcome === "already_active") { signupComplete = true; setMessage("Diese Adresse ist bereits angemeldet. Der Wirkungsbrief ist für sie aktiv."); }
        else if (result.outcome === "already_pending") { signupComplete = true; setMessage("Bitte prüfen Sie Ihr E-Mail-Postfach und bestätigen Sie die Anmeldung."); }
        else if (result.outcome === "contact_required") {
          signupUncertain = true;
          setMessage("Für diese Adresse ist eine manuelle Klärung nötig. Bitte wenden Sie sich an uns.", true);
        } else if (result.outcome === "accepted" && result.delivery === "sent") { signupComplete = true; setMessage("Bitte bestätigen Sie jetzt die E-Mail in Ihrem Postfach."); }
        else if (result.outcome === "accepted" && result.delivery === "not_sent") { signupUncertain = true; setMessage("Die Anmeldung ist noch nicht aktiv. Die Bestätigungs-E-Mail konnte nicht versandt werden. Bitte wenden Sie sich an uns.", true); }
        else throw new Error("unrecognised outcome");
      } catch (error) {
        if (!definitiveRejection) signupUncertain = true;
        const text = signupUncertain
          ? "Wir konnten keine sichere Rückmeldung erhalten. Bitte prüfen Sie Ihr E-Mail-Postfach auf eine Bestätigung und wenden Sie sich bei Bedarf an uns."
          : error instanceof Error ? error.message : "Die Newsletter-Anmeldung konnte nicht verarbeitet werden.";
        setMessage(text, true);
      } finally {
        signupPending = false;
        submit.disabled = !signupAvailable || signupUncertain || signupComplete;
      }
    });
  }

  setSignupAvailable(false);
  loadState();
})();
