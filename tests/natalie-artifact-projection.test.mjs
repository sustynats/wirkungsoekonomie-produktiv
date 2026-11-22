import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refreshNatalieProjection } from "../scripts/quality/refresh-natalie-projection.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputs = [
  "scripts/natalie/build-natalie-pages.mjs",
  "scripts/natalie/build-booking-verification.mjs",
  "components/natalie/telephone-booking.mjs",
  "content/natalie/telephone-booking.json",
  "ops/telephone-booking/templates/verify.html",
  "ops/telephone-booking/static/phone-verify.js",
  "ops/telephone-booking/static/manage.css",
  "scripts/site/normalize-site-header.mjs",
  "scripts/site/normalize-site-footer.mjs",
  "scripts/lib/booking-verification-shell.mjs",
  "scripts/lib/public-html.mjs",
  "scripts/lib/site-shell.mjs",
  "scripts/polls/privacy.mjs",
  "assets/data/navigation.json",
  "templates/footer-shell.html",
  "content/site/navigation-footer-migrations.json",
  "w/natalie-weber/anfrage-bestaetigen/index.html",
  "assets/js/telephone-booking-verify.js",
  "assets/css/telephone-booking-verify.css",
];

test("artifact pre-copy refresh replaces stale booking policy from canonical sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natalie-artifact-projection-"));
  try {
    for (const relative of inputs) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repository, relative), destination);
    }
    const profile = path.join(root, "w/natalie-weber/index.html");
    fs.mkdirSync(path.dirname(profile), { recursive: true });
    fs.writeFileSync(profile, "<html><body>höchstens vier Wochen im Voraus; innerhalb von 30 Minuten; Reservierung 48 Stunden</body></html>");

    // This is the same real subprocess call used before the artifact copy.
    // The generator lives inside the fixture, so its import.meta.url root is exact.
    refreshNatalieProjection(root);

    const html = fs.readFileSync(profile, "utf8");
    assert.match(html, /höchstens drei Kalendermonate im Voraus/);
    assert.match(html, /15\. Dezember 2026 bis einschließlich 15\. Januar 2027/);
    assert.match(html, /innerhalb von 72 Stunden/);
    assert.doesNotMatch(html, /höchstens vier Wochen|innerhalb von 30 Minuten|Reservierung 48 Stunden/);
    assert.deepEqual(
      fs.readFileSync(path.join(root, "assets/js/telephone-booking-verify.js")),
      fs.readFileSync(path.join(root, "ops/telephone-booking/static/phone-verify.js")),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(root, "assets/css/telephone-booking-verify.css")),
      fs.readFileSync(path.join(root, "ops/telephone-booking/static/manage.css")),
    );

    const outputs = {};
    function record(directory) {
      for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const relative = path.posix.join(directory, entry.name);
        if (entry.isDirectory()) record(relative);
        else outputs[relative] = createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
      }
    }
    record("w/natalie-weber");
    record("assets");
    console.log("NATALIE_PROJECTION_OUTPUTS=" + JSON.stringify(outputs));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("artifact refresh restores scoped headers and survives the final footer stage", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "natalie-shell-integration-")));
  try {
    for (const relative of inputs) {
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repository, relative), destination);
    }
    const verification = [
      "w/natalie-weber/anfrage-bestaetigen/index.html",
      "assets/js/telephone-booking-verify.js",
      "assets/css/telephone-booking-verify.css",
    ];
    const originalVerification = new Map(verification.map(relative => [relative, fs.readFileSync(path.join(root, relative))]));
    const foreignPath = path.join(root, "unrelated/index.html");
    const foreignHtml = "<html><head></head><body>Unrelated route stays unchanged.</body></html>";
    fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
    fs.writeFileSync(foreignPath, foreignHtml);

    refreshNatalieProjection(root);
    assert.equal(fs.readFileSync(foreignPath, "utf8"), foreignHtml);
    for (const [relative, before] of originalVerification) {
      assert.deepEqual(fs.readFileSync(path.join(root, relative)), before);
    }

    const shell = await import(pathToFileURL(path.join(root, "scripts/lib/site-shell.mjs")));
    const routes = ["", "biografie/", "urheberschaft/", "publikationen/", "podcast/", "musik/", "presse/", "faq/"];
    const headers = {};
    for (const route of routes) {
      const relative = "w/natalie-weber/" + route + "index.html";
      const html = fs.readFileSync(path.join(root, relative), "utf8");
      const expected = shell.renderSiteHeader(shell.pageBase(relative));
      assert.ok(html.includes(expected), relative);
      assert.equal((html.match(/<header class="site-header"/g) || []).length, 1, relative);
      assert.match(html, /assets\/css\/style\.css\?v=/);
      assert.match(html, /assets\/js\/site-navigation\.js\?v=/);
      headers[relative] = createHash("sha256").update(expected).digest("hex");
    }

    // Reproduce only the existing copy -> final artifact footer boundary.
    // No complete artifact build, provider or old projection suite is run.
    const artifact = path.join(root, "_site");
    fs.mkdirSync(artifact);
    for (const directory of ["w", "assets"]) {
      fs.cpSync(path.join(root, directory), path.join(artifact, directory), { recursive: true });
    }
    execFileSync(process.execPath, [path.join(root, "scripts/site/normalize-site-footer.mjs"), "--artifact"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 1_048_576,
    });
    const footers = {};
    for (const route of routes) {
      const relative = "w/natalie-weber/" + route + "index.html";
      const html = fs.readFileSync(path.join(artifact, relative), "utf8");
      const base = shell.pageBase(relative);
      const expected = shell.renderSiteFooter(base).replace(`<a href="${base}en/" data-nav-match="en/">English</a>\n`, "");
      assert.ok(html.includes(expected), relative);
      assert.ok(html.includes(shell.renderSiteHeader(base)), relative);
      assert.equal((html.match(/<footer class="footer"/g) || []).length, 1, relative);
      footers[relative] = createHash("sha256").update(expected).digest("hex");
    }
    for (const [relative, before] of originalVerification) {
      assert.deepEqual(fs.readFileSync(path.join(artifact, relative)), before);
    }
    console.log("NATALIE_SHELL_OUTPUTS=" + JSON.stringify({
      headers, footers, verification_unchanged: verification, foreign_route_unchanged: true,
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
