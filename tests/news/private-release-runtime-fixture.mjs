// Synthetic fixture contains no user content and never generates or publishes data.
import {readReleasedPart} from '../../scripts/news/release-part.mjs';
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'sustynats/wirkungsoekonomie-produktiv')
  throw Error('PRIVATE_RELEASE_FIXTURE_CONTEXT_INVALID');
const part = {"sha256":"35356cf703b6dd3b4ef2d26412ff8e12761e2cddde3bb2d5935903a5147cbdd0","bytes":63,"release":{"repository":"sustynats/wirkungsoekonomie-produktiv","storage_format":"woek-release-part-gzip-1","tag":"wirkungsticker-data-2000-01-part-999","asset":"35356cf703b6dd3b4ef2d26412ff8e12761e2cddde3bb2d5935903a5147cbdd0.json.gz","sha256":"e193d5c5cf6bdc594ab99821f3d706cdde50e271fd073e2c0cbf533dde33a366","bytes":83}};
const data = readReleasedPart(part);
if (data.toString('utf8') !== "{\"fixture\":\"woek-private-release-integration-v1\",\"records\":[]}\n") throw Error('PRIVATE_RELEASE_FIXTURE_CONTENT_MISMATCH');
console.log('PRIVATE_RELEASE_FIXTURE_AUTHENTICATED_READ_PASS');
