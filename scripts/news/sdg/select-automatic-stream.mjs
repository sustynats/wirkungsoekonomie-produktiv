import { appendFileSync } from 'node:fs';
import { loadSdgTickerPresentation, readSdgCatalogIndex } from './release-catalog.mjs';

const root = process.cwd();
const presentation = loadSdgTickerPresentation(root);
const catalog = presentation ?? readSdgCatalogIndex(root);
appendFileSync(process.env.GITHUB_OUTPUT,
  `legacy_news=${presentation === null}\nsdg_catalog_registered=${catalog.releases.length > 0}\n`);
