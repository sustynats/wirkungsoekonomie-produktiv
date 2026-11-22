// Exact input identities independently recovered from failed run 41913667334.
// Input receipts preserve spend; they do not approve either original or image.
import { canonicalizeUrl } from './lib.mjs';
import { QUARANTINED_419_IDS } from './quarantined-419-evidence.mjs';
export { QUARANTINED_419_IDS, quarantine419Enabled, restored419Evidence } from './quarantined-419-evidence.mjs';

const URLS = Object.freeze([
  'https://www.bayern.de/heimat-gestalten-zukunft-schaffen-ministerin-kaniber-foerdert-projekte-in-15-gemeinden-mit-563-millionen-euro',
  'https://www.tagesspiegel.de/berlin/dpa-auf-dem-gehweg-mann-in-berlin-wedding-durch-mehrere-schusse-verletzt-16243071.html',
]);

function sameSource(raw, expected) {
  // Existing normalization removes tracking variants and upgrades legacy http
  // only on the same host as the known https original. For these two exact
  // article paths, any query is non-authoritative for this conservative hold.
  const normalized = canonicalizeUrl(raw, expected);
  if (!normalized) return false;
  const actual = new URL(normalized);
  const reference = new URL(canonicalizeUrl(expected));
  // Only for these two pinned article paths, consider the publisher's www and
  // bare hostname and http/https variants the same conservative identity.
  const host = value => value.hostname.toLowerCase().replace(/^www\./, '');
  return host(actual) === host(reference) && actual.pathname === reference.pathname;
}
export function quarantined419(record, env = process.env) {
  if (env.WOEK_NEWS_ONLY !== 'true' || !record) return false;
  if (QUARANTINED_419_IDS.includes(record.story_id) || QUARANTINED_419_IDS.includes(record.existing_story?.story_id)) return true;
  const sources = [...(record.sources || []), ...(record.existing_story?.sources || []),
    ...(record.pending_update?.sources || []), ...(record.existing_story?.pending_update?.sources || [])];
  return sources.some(source => URLS.some(url => sameSource(source?.url, url)));
}
