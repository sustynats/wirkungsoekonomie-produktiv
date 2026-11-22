// Allocation mechanics only. Callers must authorize their own repository and
// provide transports; this module has no default network or publication access.
import fs from "node:fs";
import path from "node:path";
import { digest, imageError } from "./policy.mjs";

export function createImmutableReleaseAllocator({ repository, run, download }) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository || "") || typeof run !== "function" || typeof download !== "function") throw imageError("IMAGE_RELEASE_TRANSPORT_INVALID");
  const assetUrl = (tag, name) => `https://github.com/${repository}/releases/download/${tag}/${name}`;
  return async function publish(files, { tag }) {
    if (!/^wirkungsticker-media-\d{4}-\d{2}$/.test(tag)) throw imageError("IMAGE_RELEASE_INVALID");
    for (const file of files) {
      if (!/^[a-z0-9.-]+$/.test(path.basename(file))) throw imageError("IMAGE_ASSET_NAME_INVALID");
    }
    // A GitHub release accepts 1,000 assets. Keep old URLs immutable and move
    // whole new image sets to a bounded, same-month continuation archive.
    for (let part = 1; part <= 32; part += 1) {
      const selected = part === 1 ? tag : `${tag}-part-${part}`;
      let release;
      try { release = JSON.parse(await run(["release", "view", selected, "--repo", repository, "--json", "assets"])); }
      catch (error) {
        if (!/release not found|not found|HTTP 404/i.test(error?.stderr || error?.message || "")) throw error;
        await run(["release", "create", selected, "--repo", repository, "--target", "main", "--title", `Wirkungsticker-Medien ${tag.slice(-7)}${part > 1 ? ` · Teil ${part}` : ""}`, "--notes", "Unveränderliche Originalmotive und gerenderte Titelbilder des Wirkungstickers. KI-Motive sind Symbolbilder, keine Ereignisfotografien.", "--latest=false"]);
        release = JSON.parse(await run(["release", "view", selected, "--repo", repository, "--json", "assets"]));
      }
      const existing = new Map(release.assets.map(a => [a.name, a]));
      const missing = files.filter(file => !existing.has(path.basename(file)));
      if (release.assets.length + missing.length > 1000) continue;
      try {
        for (const file of files) {
          const old = existing.get(path.basename(file));
          if (old) {
            const expected = digest(fs.readFileSync(file));
            if (old.size !== fs.statSync(file).size) throw imageError("IMAGE_IMMUTABLE_ASSET_CONFLICT");
            const actual = old.digest?.replace(/^sha256:/, "") || (await download(assetUrl(selected, path.basename(file)), { minWidth: 1080 })).sha256;
            if (actual !== expected) throw imageError("IMAGE_IMMUTABLE_ASSET_CONFLICT");
          } else await run(["release", "upload", selected, file, "--repo", repository]); // never --clobber
        }
        return Object.fromEntries(files.map(file => [path.basename(file), assetUrl(selected, path.basename(file))]));
      } catch (error) {
        // Another publisher may have filled the archive after our read. Other
        // errors (including immutable conflicts) must never be hidden.
        if (/file_count limited to 1000 assets per release/.test(error?.stderr || error?.message || "")) continue;
        throw error;
      }
    }
    throw imageError("IMAGE_RELEASE_CAPACITY_EXHAUSTED");
  };
}
