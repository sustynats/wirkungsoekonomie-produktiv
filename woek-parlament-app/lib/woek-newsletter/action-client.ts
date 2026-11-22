export const newsletterBackend = "https://woek-parlament.vercel.app";
export type NewsletterAction = "confirm" | "unsubscribe";
export type NewsletterActionResult = { state: "navigating" | "complete" | "rejected" | "uncertain"; message: string };
const publicHosts = new Set(["wirkungsoekonomie.de", "www.wirkungsoekonomie.de", "parlament.wirkungsoekonomie.de"]);

export function newsletterActionTarget(action: NewsletterAction, search: string) {
  if (action !== "confirm" && action !== "unsubscribe") throw new Error("Ungültiger Vorgang.");
  const input = new URLSearchParams(search);
  if (input.has("delivery")) throw new Error("Dieser Abmeldelink gehört zu einem anderen Versandweg. Bitte wenden Sie sich an uns; eine Abmeldung wurde noch nicht durchgeführt.");
  const fields = action === "confirm" ? ["subscription", "token", "unsubscribe_token"] : ["subscription", "token"];
  const output = new URLSearchParams();
  for (const name of fields) {
    const values = input.getAll(name);
    if (name === "unsubscribe_token" && values.length === 0) continue;
    const value = values[0] || "";
    const valid = name === "subscription" ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) : /^[A-Za-z0-9_-]{43}$/.test(value);
    if (values.length !== 1 || !valid) throw new Error("Dieser Link ist unvollständig oder ungültig. Bitte öffnen Sie den vollständigen Link aus Ihrer E-Mail.");
    output.set(name, value);
  }
  const route = action === "confirm" ? "bestaetigen" : "abmelden";
  return { url: `${newsletterBackend}/woek-newsletter/${route}?${output}`, endpoint: `/api/woek-newsletter/${route}`, body: Object.fromEntries(output) };
}

export async function performNewsletterAction(action: NewsletterAction, search: string, hostname: string, navigate: (url: string) => void, request: typeof fetch = fetch): Promise<NewsletterActionResult> {
  let target: ReturnType<typeof newsletterActionTarget>;
  try { target = newsletterActionTarget(action, search); }
  catch (error) { return { state: "rejected", message: error instanceof Error ? error.message : "Ungültiger Link." }; }
  if (hostname !== "woek-parlament.vercel.app") {
    if (!publicHosts.has(hostname)) return { state: "rejected", message: "Dieser Vorgang ist auf dieser Website nicht verfügbar." };
    try { navigate(target.url); }
    catch { return { state: "rejected", message: "Die sichere Seite konnte nicht geöffnet werden. Bitte versuchen Sie es erneut." }; }
    return { state: "navigating", message: "Sie werden zur sicheren Seite weitergeleitet. Dort führen Sie den Vorgang mit einem weiteren Klick aus." };
  }
  try {
    const response = await request(target.endpoint, { method: "POST", credentials: "same-origin", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: JSON.stringify(target.body) });
    const result = await response.json() as { outcome?: string; error?: string };
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw new Error("uncertain outcome");
    if (!response.ok) return { state: "rejected", message: result.error || "Der Link konnte nicht verarbeitet werden." };
    const valid = action === "confirm" ? result.outcome === "confirmed" || result.outcome === "already_active" : result.outcome === "unsubscribed";
    if (!valid) throw new Error("unrecognised outcome");
    return { state: "complete", message: action === "confirm" ? "Ihre Anmeldung zum Wirkungsbrief ist bestätigt." : "Ihre Abmeldung vom Wirkungsbrief ist bestätigt." };
  } catch {
    return { state: "uncertain", message: "Wir konnten keine sichere Rückmeldung erhalten. Bitte prüfen Sie Ihr Postfach oder wenden Sie sich an uns, bevor Sie es erneut versuchen." };
  }
}
