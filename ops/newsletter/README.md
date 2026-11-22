# Wirkungsbrief runtime

The public signup, confirmation and unsubscribe endpoints run on the existing
Oracle host. They bundle the existing Parliament subscription implementation,
email templates and database adapter. Supabase remains the same protected
subscription store; this release performs no schema or subscriber migration.

Build locally with `npm ci && npm test && npm run build` in this directory.
The release contains `dist`, `package.json`, `package-lock.json` and production
dependencies only. Node 22 is required. No build or new resource is needed on
Vercel. The service is restricted to loopback, 160 MB RAM and 25% CPU.

Private `/etc/woek-newsletter.env` provides the existing protected database URL
and service role, the established domain mailbox's SMTP configuration under
`WOEK_NEWSLETTER_SMTP_*`, plus:

```
PORT=8793
WOEK_NEWSLETTER_EMAIL_SEND_MODE=production
WOEK_NEWSLETTER_DELIVERY_PROVIDER=ionos_smtp
WOEK_NEWSLETTER_PUBLIC_SIGNUP_ENABLED=true
NEXT_PUBLIC_PORTAL_URL=https://130.162.217.58.sslip.io
NEXT_PUBLIC_WOEK_WEBSITE_URL=https://wirkungsoekonomie.de
```

Use the existing newsletter sender identity for FROM/REPLY_TO. Never commit the
private environment file. SMTP verification authenticates without sending mail;
it runs at startup and every five minutes. A delivery failure closes signup
until authentication succeeds again. Confirmation and unsubscribe stay available.
Pending requests with expired confirmation links may request a new link.

Caddy routes `/api/woek-newsletter`, `/api/woek-newsletter/*` and
`/woek-newsletter/*` to `127.0.0.1:8793`. Disable access logging for these routes
and overwrite `X-Real-IP`. Confirmation GETs are inert: only an explicit button
click sends the token in a JSON POST. Query strings and recipient data must not
be added to application logs. The runtime does not set recognition cookies.

Before switching the client, save the prior Caddy configuration and service
release privately, export the existing newsletter tables privately and verify
their restored local JSON against the source records. Compare the subscriber
inventory again after startup. Keep production data out of release artifacts.
Rollback switches the `current` symlink to the preceding tested release and
reverts the client-origin change; it never restores an old copy over live data.
Old Vercel confirmation links remain valid against the unchanged database.

Validation uses synthetic data with in-memory database and SMTP doubles. Live
readiness, CORS and rejection paths can be checked without sending mail. A real
mailbox delivery test requires the user's instruction to send that test.

The manual `newsletter-release.yml` workflow publishes only the repaired client,
its cache key/API-origin attributes and two matching privacy paragraphs. Like the
existing isolated Pages releases, it starts from the exact active artifact,
verifies its immutable archive digest and domain, proves all other bytes remain
unchanged, runs the existing size/privacy gates and rejects a stale baseline.
Dispatch it on main with the exact reviewed `expected_commit`. Commits marked
`[newsletter-release]` do not also start the unrelated full-site rebuild.
