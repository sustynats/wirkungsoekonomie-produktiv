"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { performNewsletterAction, type NewsletterAction as Action } from "@/lib/woek-newsletter/action-client";

type ActionState = "idle" | "pending" | "navigating" | "complete" | "rejected" | "uncertain";

export default function NewsletterAction({ action }: { action: Action }) {
  const params = useSearchParams();
  const lock = useRef(false);
  const [backend, setBackend] = useState(false);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ActionState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setBackend(window.location.hostname === "woek-parlament.vercel.app"); setReady(true); }, []);
  async function act() {
    if (lock.current) return;
    lock.current = true;
    setState("pending");
    const result = await performNewsletterAction(action, params.toString(), window.location.hostname, (url) => {
      const link = document.createElement("a");
      link.href = url;
      link.referrerPolicy = "no-referrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
    setState(result.state);
    setMessage(result.message);
    if (result.state === "complete") window.history.replaceState({}, document.title, window.location.pathname);
    if (result.state === "rejected") lock.current = false;
  }
  const confirm = action === "confirm";
  const blocked = !ready || state === "pending" || state === "navigating" || state === "complete" || state === "uncertain";
  const label = backend
    ? (confirm ? "Anmeldung bestätigen" : "Wirkungsbrief abmelden")
    : (confirm ? "Weiter zur sicheren Bestätigung" : "Weiter zur sicheren Abmeldung");
  return (
    <div className="shell content-page confirmation-page">
      <p className="eyebrow">E-Mail-Anmeldung</p>
      <h1>Der Wirkungsbrief: {confirm ? "Anmeldung bestätigen" : "abmelden"}</h1>
      <p className="lead">
        {backend
          ? (confirm ? "Mit der Bestätigung aktivieren Sie den Wirkungsbrief." : "Mit der Abmeldung beenden Sie Ihr Wirkungsbrief-Abonnement.")
          : "Öffnen Sie die sichere Seite. Erst dort bestätigen Sie den Vorgang mit einem weiteren Klick."}
      </p>
      <button type="button" className="button button-primary" onClick={act} disabled={blocked} aria-busy={state === "pending"}>
        {state === "pending" ? "Wird verarbeitet …" : label}
      </button>
      {message ? <p className="notice" role="status">{message}</p> : null}
      <p className="page-return">
        <a href="https://wirkungsoekonomie.de/" referrerPolicy="no-referrer">Zur Website der Wirkungsökonomie</a>
      </p>
    </div>
  );
}
