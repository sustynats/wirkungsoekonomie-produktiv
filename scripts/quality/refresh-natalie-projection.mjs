import path from "node:path";
import { execFileSync } from "node:child_process";

// The fast ticker release also packages profile HTML. Rebuild that projection
// from the existing canonical generator before an old checkout copy can ship.
export function refreshNatalieProjection(root) {
  for (const args of [
    [path.join(root, "scripts/natalie/build-natalie-pages.mjs")],
    // The early workflow normalization preceded regeneration. Restore the
    // existing shared header only on these pages; its verification guard stays.
    [path.join(root, "scripts/site/normalize-site-header.mjs"), "--prefix=w/natalie-weber/"],
  ]) {
    const output = execFileSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      maxBuffer: 1_048_576,
    });
    process.stdout.write(output);
  }
}
