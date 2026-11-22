// These published bundles contain shareable campaign images, not library
// source documents. Keep this exception limited to the four reviewed assets;
// arbitrary ZIP files and publication source packages still fail the gate.
const RELEASE = 'https://github.com/sustynats/wirkungsoekonomie-medien/releases/download/werteadvent-2026-v2/';
const MEDIA_BUNDLES = new Set([
  'WerteAdvent_2026_Icons_mit_Beschriftung_v2.zip',
  'WerteAdvent_2026_Icons_ohne_Beschriftung.zip',
  'WerteAdvent_2026_24_Comic_Icons_v2.zip',
  'WerteAdvent_2026_Hochformat_Vorlagen.zip',
].map(name => RELEASE + name));

export function isPublicMediaBundle(href) {
  return MEDIA_BUNDLES.has(href);
}
