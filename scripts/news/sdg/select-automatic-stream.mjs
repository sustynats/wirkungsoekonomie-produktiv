import { appendFileSync } from 'node:fs';
import { loadSdgTickerPresentation } from './release-catalog.mjs';

const legacyNews = loadSdgTickerPresentation(process.cwd()) === null;
appendFileSync(process.env.GITHUB_OUTPUT, `legacy_news=${legacyNews}\n`);
