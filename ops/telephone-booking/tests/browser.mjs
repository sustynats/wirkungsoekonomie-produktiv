// Run against the synthetic loopback preview. No live messages or appointments.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
const { chromium } = await import(process.env.BOOKING_PLAYWRIGHT || "playwright");
const base = "http://127.0.0.1:8766";
const out = process.env.BOOKING_SCREENSHOTS || "/tmp/woek-booking-preview";
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
assert.equal((await context.request.post(`${base}/__test__/reset`, { headers: { Origin: base }, data: {} })).status(), 200);
// Some unchanged assets in the checkout are cloud placeholders. Use the actual
// deployed assets for visual verification, without changing repository files.
await page.route("**/assets/**", async (route) => {
  const url = new URL(route.request().url());
  if (!/^\/assets\/(fonts|img)\//.test(url.pathname)) return route.continue();
  const response = await route.fetch({ url: `https://wirkungsoekonomie.de${url.pathname}`, timeout: 20000 });
  await route.fulfill({ response });
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const globalCss = process.env.BOOKING_GLOBAL_CSS ? (await fs.readFile(process.env.BOOKING_GLOBAL_CSS, "utf8")).replaceAll('url("../fonts/', 'url("/assets/fonts/').replaceAll("url('../fonts/", "url('/assets/fonts/") : null;

async function profile(route = "") {
  await page.goto(`${base}/w/natalie-weber/${route}`, { waitUntil: "networkidle" });
  // Reproduce the deployed order: global CSS appended after the local profile CSS.
  if (globalCss) await page.addStyleTag({ content: globalCss });
}
function luminance(rgb) {
  const channels = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a, b) { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + .05) / (Math.min(la, lb) + .05); }
const contrastResults = [];
try {
  for (const route of ["", "biografie/", "urheberschaft/", "publikationen/", "podcast/", "musik/", "presse/", "faq/"]) {
    await profile(route);
    const styles = await page.evaluate(() => {
      const css = (selector) => { const el = document.querySelector(selector); if (!el) return null; const s = getComputedStyle(el); return { color: s.color, background: s.backgroundColor, image: s.backgroundImage }; };
      return { hero: css("#natalie-profile .hero"), title: css("#natalie-profile h1"), subtitle: css("#natalie-profile .hero .sub"), primary: css("#natalie-profile .btn-primary"), darkLead: css("#natalie-profile .band-dark .lead-p") };
    });
    assert(styles.hero.image.includes("rgb(16, 31, 56)"), `${route}: profile hero overwritten`);
    for (const [label, foreground, background] of [["title", styles.title.color, "rgb(22, 41, 74)"], ["subtitle", styles.subtitle.color, "rgb(22, 41, 74)"], ...(styles.primary ? [["primary button", styles.primary.color, styles.primary.background]] : []), ...(styles.darkLead ? [["dark section", styles.darkLead.color, "rgb(22, 41, 74)"]] : [])]) {
      const ratio = contrast(foreground, background);
      assert(ratio >= 4.5, `${route} ${label}: ${ratio}`);
      contrastResults.push({ route: route || "Profil", element: label, ratio: Number(ratio.toFixed(2)) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route}: mobile overflow`);
    if (route === "presse/") await page.screenshot({ path: path.join(out, "presse-mobile.png") });
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (process.env.BOOKING_AXE) {
      await page.evaluate(() => document.fonts.ready);
      await page.addScriptTag({ path: process.env.BOOKING_AXE });
      const audit = await page.evaluate(async () => window.axe.run(document.querySelector("#natalie-profile"), { runOnly: { type: "rule", values: ["color-contrast"] } }));
      assert.deepEqual(audit.violations.map((v) => ({ id: v.id, elements: v.nodes.map((n) => n.target) })), [], `${route}: color contrast audit`);
    }
  }
  await profile();
  await page.screenshot({ path: path.join(out, "profil-desktop.png") });
  await page.locator("#gespraech").evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.screenshot({ path: path.join(out, "buchung-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#gespraech").evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
  await page.screenshot({ path: path.join(out, "buchung-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });

  async function fill(channel, email) {
    await page.locator("[data-booking-days] button").first().click();
    await page.locator("[data-booking-slots] button").first().click();
    await page.locator('[name="name"]').fill("Synthetische Testperson");
    await page.locator('[name="email"]').fill(email);
    await page.locator('[name="channel"]').selectOption(channel);
    if (channel === "phone") await page.locator('[name="phone"]').fill("+49 151 00000000");
    else await page.locator('[name="discord"]').fill("typed.synthetic");
    await page.locator('[name="topic"]').selectOption("praxis");
    await page.locator('[name="background"]').fill("Synthetischer Hintergrund zur technischen Prüfung des Formulars.");
    await page.locator('[name="questions"]').fill("Wie wird die Anfrage bearbeitet?");
    await page.locator('[name="outcome"]').fill("Den Ablauf gemeinsam verstehen.");
    await page.locator('[name="acknowledged"]').check();
    const response = page.waitForResponse((response) => response.url().endsWith("/requests") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Gesprächstermin anfragen" }).click();
    const result = await response;
    assert.equal(result.status(), 202);
    return result.json();
  }
  const phone = await fill("phone", "browser-phone@example.org");
  assert((await page.locator("[data-booking-result]").textContent()).includes("E-Mail mit Bestätigungslink"));
  const links = await (await context.request.get(`${base}/__test__/links/${phone.reference}`)).json();
  await page.goto(links.verify);
  await page.getByRole("button", { name: "Anfrage bestätigen und an Natalie senden" }).click();
  await page.getByText("Deine Anfrage ist bestätigt", { exact: false }).waitFor();
  await page.goto(links.admin);
  await page.getByRole("button", { name: "Termin zusagen", exact: true }).click();
  await page.getByText("Zugesagt.", { exact: false }).waitFor();
  assert((await page.locator("#draft").inputValue()).includes("hiermit bestätige ich"));
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Kalenderdatei herunterladen" }).click();
  assert.equal((await download).suggestedFilename(), "gespraech-nats.ics");
  await page.getByRole("button", { name: "Ich habe die Antwort versandt" }).click();
  await page.getByText("Persönliche Antwort als versandt markiert.", { exact: false }).waitFor();

  await profile();
  const discord = await fill("discord", "browser-discord@example.org");
  await page.locator("[data-booking-next] a").click();
  await page.route("https://discord.com/oauth2/authorize**", async (route) => {
    const state = new URL(route.request().url()).searchParams.get("state");
    await route.fulfill({ status: 302, headers: { location: `${base}/api/telephone-booking/discord/callback?code=synthetic&state=${encodeURIComponent(state)}` } });
  });
  await page.getByRole("button", { name: "Bei Discord anmelden und Account prüfen" }).click();
  await page.getByText("Dein Discord-Account wurde geprüft: @verified.synthetic.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Anfrage bestätigen und an Natalie senden" }).click();
  await page.getByText("Deine Anfrage ist bestätigt", { exact: false }).waitFor();
  assert(discord.verificationUrl);
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, "results.json"), JSON.stringify({ pagesChecked: 8, mobileOverflow: false, phoneFlow: "PASS", discordFlow: "PASS (mock OAuth provider)", contrastResults, errors }, null, 2));
  console.log(`PASS: 8 profile pages, desktop/mobile contrast and overflow, phone verification → approval → ICS → reply tracking, Discord OAuth → explicit confirmation. Screenshots: ${out}`);
} finally {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await browser.close();
}
