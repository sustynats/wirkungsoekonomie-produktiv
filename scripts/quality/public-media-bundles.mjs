// These exact published bundles contain reviewed images. The list leaves
// arbitrary ZIP files and publication source packages subject to the PDF gate.
const MEDIA = 'https://github.com/sustynats/wirkungsoekonomie-medien/releases/download/';
const RELEASE = MEDIA + 'werteadvent-2026-v2/';
const MEDIA_BUNDLES = new Set([
  'WerteAdvent_2026_Icons_mit_Beschriftung_v2.zip',
  'WerteAdvent_2026_Icons_ohne_Beschriftung.zip',
  'WerteAdvent_2026_24_Comic_Icons_v2.zip',
  'WerteAdvent_2026_Hochformat_Vorlagen.zip',
].map(name => RELEASE + name));
for (const language of ['de', 'en']) {
  MEDIA_BUNDLES.add(MEDIA + `woek-sdgplus-v1/sdgplus-zielkarten-${language}.zip`);
}

export function isPublicMediaBundle(href) {
  return MEDIA_BUNDLES.has(href);
}
