import fs from 'node:fs';
import path from 'node:path';
import { personalContentHash } from '../news/personal-editorial.mjs';

// Public subject/source names in one already approved manuscript. This is not
// an article-wide exemption: only these exact, reviewed occurrences are masked
// for the production-name check. Every other privacy rule scans the original.
const reviewed = {
  analysis_id: 'woek-personal-a5af43a9262df8f2',
  slug: 'wenn-die-ki-zum-taschengott-wird-nachgehort-mit-sascha-lobo-und-elisabeth-l-orange-a5af43',
  content_hash: '0e055e6e550d934a21c239881ea5efe96e499352672fad62434cdfaefd4e1568',
  references: [
    'Anthropic untersuchte persönliche Beratung in Claude-Konversationen',
    'Die Studien beziehen sich auf Claude und sind nicht ohne Weiteres',
    'How people ask Claude for personal guidance',
  ],
  source_url: 'https://www.anthropic.com/research/claude-personal-guidance',
};

export function textForProductionNameCheck(root, relative, text) {
  if (relative !== `_site/wirkungsticker/analyse/${reviewed.slug}/index.html`
    || !text.includes(`data-editorial-content-hash="${reviewed.content_hash}"`)) return text;
  let edition;
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/news/personal-editorials.json'), 'utf8'));
    edition = catalog.editions.find(item => item.analysis_id === reviewed.analysis_id);
    if (edition?.content_hash !== reviewed.content_hash || edition.slug !== reviewed.slug
      || personalContentHash(edition) !== reviewed.content_hash) return text;
  } catch { return text; } // Missing or changed provenance never grants an exception.
  const approvedText = [edition.body_markdown, ...edition.sources.map(source => source.title)].join('\n');
  for (const reference of reviewed.references) {
    if (!approvedText.includes(reference)) return text;
  }
  if (!edition.sources.some(source => source.url === reviewed.source_url)) return text;
  let checked = text;
  for (const reference of reviewed.references) {
    // Replace one occurrence only; duplicated or additional tool references
    // still reach the production-name gate and need their own review.
    checked = checked.replace(reference, reference.replace(/\bClaude\b/, 'reviewed-public-product'));
  }
  // The original source URL appears once in Article.citation and once in the
  // visible bibliography. Its product name is also a legitimate reference.
  for (let occurrence = 0; occurrence < 2; occurrence += 1) {
    checked = checked.replace(reviewed.source_url, reviewed.source_url.replace('claude', 'reviewed-public-product'));
  }
  return checked;
}
