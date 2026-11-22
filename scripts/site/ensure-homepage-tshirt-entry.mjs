import fs from 'node:fs';

const homepageFile = 'index.html';
const sourceFile = 'verstehen/index.html';
const marker = /<!-- two-shirts-entry:start -->[\s\S]*?<!-- two-shirts-entry:end -->/;
const homepage = fs.readFileSync(homepageFile, 'utf8');
const currentIntro = homepage.replace(
  'Die Wirkungsökonomie ist ein umfassendes Wirtschafts- und Gesellschaftsmodell.',
  'Die Wirkungsökonomie ist ein umfassendes Wirtschafts-, Gesellschafts- und Steuerungsmodell.',
);
const source = fs.readFileSync(sourceFile, 'utf8');
const entry = source.match(marker)?.[0];
if (!entry) throw new Error('Canonical T-shirt entry is missing from verstehen/index.html');
const updated = marker.test(currentIntro)
  ? currentIntro.replace(marker, () => entry)
  : currentIntro.replace(
    /(<section class="hero home-journey-hero"[\s\S]*?<\/section>)/,
    (_, hero) => `${hero}\n${entry}`,
  );
if (!marker.test(updated)) throw new Error('Homepage hero not found while restoring T-shirt entry');
if (updated !== homepage) fs.writeFileSync(homepageFile, updated);
console.log('Synchronized the homepage definition and T-shirt entry.');
