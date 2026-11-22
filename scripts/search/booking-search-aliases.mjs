// Pure preparation only: invoke as part of the future verified booking release.
// No filesystem, network, or live publication is performed here.
const TARGET_URL = '/w/natalie-weber/';
const TARGET_ID = 'page-w-natalie-weber-index';
const BOOKING_ALIASES = ['Gesprächstermin anfragen', 'Telefontermin Natalie Weber', 'Discord-Gespräch Natalie Weber'];

export function addBookingSearchAliases(entries) {
  if (!Array.isArray(entries)) throw new TypeError('search index must be an array');
  const matches = entries.filter((entry) => entry?.url === TARGET_URL);
  if (matches.length !== 1 || matches[0].id !== TARGET_ID || !Array.isArray(matches[0].aliases)) {
    throw new Error('the exact existing Natalie profile entry is required');
  }
  return entries.map((entry) => entry === matches[0]
    ? {...entry, aliases: [...new Set([...entry.aliases, ...BOOKING_ALIASES])]}
    : entry);
}
