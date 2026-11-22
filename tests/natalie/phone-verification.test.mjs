import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildPhoneVerificationPage, VERIFICATION_ROUTE } from "../../scripts/natalie/build-booking-verification.mjs";
import { preserveBookingVerificationShell } from "../../scripts/lib/booking-verification-shell.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = fs.readFileSync(path.join(ROOT, "ops/telephone-booking/static/phone-verify.js"), "utf8");
const TOKEN = "synthetic_capability_" + "x".repeat(24);
const PAGE = "/w/natalie-weber/anfrage-bestaetigen/";
const API = "https://130.162.217.58.sslip.io/api/telephone-booking/verify/request";
const tick = () => new Promise(resolve => setImmediate(resolve));

function browser({ hash = "#" + TOKEN, origin = "https://wirkungsoekonomie.de", response, fetchError } = {}) {
  const events = {}, calls = [], history = [], logs = [];
  const elements = Object.fromEntries(["message", "details", "identity", "confirm"].map(id => [id, {
    textContent: "", hidden: id === "confirm", disabled: false,
    addEventListener(event, fn) { events[id + ":" + event] = fn; },
    set innerHTML(value) { throw new Error("HTML injection attempted"); }
  }]));
  const context = vm.createContext({
    location: { hash, pathname: PAGE, origin },
    history: { replaceState(state, title, url) { history.push(url); } },
    document: { readyState: "loading", getElementById(id) { return elements[id]; },
      addEventListener(event, fn) { events[event] = fn; } },
    console: { log(...args) { logs.push(args); }, error(...args) { logs.push(args); } },
    AbortSignal: { timeout(ms) { return { timeout: ms }; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchError) throw fetchError;
      return response || { ok: true, status: 200, json: async () => ({ channel: "phone", status: options.method === "POST" ? "pending" : "unverified", start: "2026-11-17T09:00:00Z" }) };
    }
  });
  for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(context, name, { get() { throw new Error("Storage forbidden"); } });
  vm.runInContext(source, context);
  return { context, events, calls, history, logs, elements };
}

test("fragment removed before DOM ready or any API call; token remains private", async () => {
  const b = browser();
  assert.deepEqual(b.history, [PAGE]);
  assert.equal(b.calls.length, 0);
  assert.equal(b.context.token, undefined);
  b.events.DOMContentLoaded(); await tick();
  assert.equal(b.calls.length, 1);
  const { url, options } = b.calls[0];
  assert.equal(url, API); assert.equal(options.method, "GET");
  assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
  assert.equal(options.referrerPolicy, "no-referrer"); assert.equal(options.mode, "cors");
  assert.equal(options.cache, "no-store"); assert.equal(options.headers.Authorization, "Bearer " + TOKEN);
  assert.equal(options.body, undefined);
  assert.equal(b.elements.confirm.hidden, false);
  assert.equal(JSON.stringify(Object.values(b.elements).map(e => e.textContent)).includes(TOKEN), false);
  assert.deepEqual(b.logs, []);
});

test("only explicit click POSTs, double clicks do not duplicate in-flight confirmation", async () => {
  const b = browser(); b.events.DOMContentLoaded(); await tick();
  const first = b.events["confirm:click"]();
  const second = b.events["confirm:click"]();
  await Promise.all([first, second]);
  assert.deepEqual(b.calls.map(call => call.options.method), ["GET", "POST"]);
  assert.equal(b.calls[1].options.body, "{}");
  assert.equal(b.elements.confirm.hidden, true);
  await b.events["confirm:click"]();
  assert.equal(b.calls.length, 2);
});

test("invalid fragment or foreign page origin cannot make API requests", async () => {
  for (const values of [{ hash: "" }, { hash: "#bad?<script>" }, { origin: "https://foreign.invalid" }]) {
    const b = browser(values); b.events.DOMContentLoaded(); await tick();
    assert.deepEqual(b.history, [PAGE]); assert.equal(b.calls.length, 0);
    assert.equal(b.elements.confirm.hidden, true);
  }
});

test("Discord and malformed response data never display or enable phone confirmation", async () => {
  for (const data of [{ channel: "discord", status: "unverified", start: "2026-11-17T09:00:00Z" },
    { channel: "phone", status: "<img src=bad>", start: "2026-11-17T09:00:00Z" },
    { channel: "phone", status: "unverified", start: "secret-value" }]) {
    const b = browser({ response: { ok: true, status: 200, json: async () => data } });
    b.events.DOMContentLoaded(); await tick();
    assert.equal(b.elements.confirm.hidden, true);
    assert.equal(b.elements.details.textContent, "");
    assert.doesNotMatch(b.elements.message.textContent, /secret-value|<img/);
    assert.equal(b.calls.length, 1);
  }
});

test("transport errors and HTTP response bodies cannot leak links or credentials", async () => {
  const leak = "https://private.invalid/?credential=SYNTHETIC_SECRET";
  for (const config of [{ fetchError: new Error(leak) },
    { response: { ok: false, status: 503, json: async () => { throw new Error("Body must not be read " + leak); } } },
    { response: { ok: false, status: 404, json: async () => ({ error: leak }) } }]) {
    const b = browser(config); b.events.DOMContentLoaded(); await tick();
    assert.doesNotMatch(b.elements.message.textContent, /SYNTHETIC_SECRET|private.invalid/);
    assert.deepEqual(b.logs, []); assert.equal(b.calls.length, 1);
  }
});

test("generator reuses template/CSS, exact service isolation contract, only one script and static footer", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "woek-phone-shell-"));
  try {
    for (const rel of ["templates/verify.html", "static/manage.css", "static/phone-verify.js"]) {
      const target = path.join(temp, "ops/telephone-booking", rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "ops/telephone-booking", rel), target);
    }
    const output = buildPhoneVerificationPage(temp);
    assert.equal(output.length, 3);
    const html = fs.readFileSync(path.join(temp, VERIFICATION_ROUTE), "utf8");
    assert.equal(preserveBookingVerificationShell(VERIFICATION_ROUTE, html), true);
    assert.equal((html.match(/<script\b/g) || []).length, 1);
    assert.match(html, /<script src="\/assets\/js\/telephone-booking-verify.js"><\/script>/);
    assert.doesNotMatch(html, /id="discord"|newsletter|analytics|{{|<form|class="site-header"/);
    assert.match(html, /<footer>/); assert.match(html, /href="\/datenschutz.html"/); assert.match(html, /href="\/w\/natalie-weber\/">Profil und Kontakt/);
    assert.match(html, /name="referrer" content="no-referrer"/);
    assert.match(html, /id="confirm" hidden/);
    assert.deepEqual(fs.readFileSync(path.join(temp, "assets/css/telephone-booking-verify.css")), fs.readFileSync(path.join(ROOT, "ops/telephone-booking/static/manage.css")));
    assert.equal(fs.readFileSync(path.join(temp, "assets/js/telephone-booking-verify.js"), "utf8"), source);
    const template = path.join(temp, "ops/telephone-booking/templates/verify.html");
    fs.writeFileSync(template, fs.readFileSync(template, "utf8").replace('id="discord"', 'id="changed"'));
    assert.throws(() => buildPhoneVerificationPage(temp), /TEMPLATE_CONTRACT_CHANGED/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
