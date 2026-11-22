import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('newsletter_release', Path(__file__).resolve().parents[2] / 'scripts/ops/prepare-newsletter-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NewsletterPatchTest(unittest.TestCase):
    def test_unrelated_content_remains_exact(self):
        before = '<html><main>Keep every byte: ä &amp; evidence.</main><script defer src="../assets/js/newsletter.js?v=old"></script><section data-woek-newsletter data-api-origin="https://woek-parlament.vercel.app"></section></html>'
        after = module.patch_html(before)
        self.assertEqual(after, before.replace('?v=old', '?v=' + module.VERSION).replace('https://woek-parlament.vercel.app', module.ORIGIN))
        self.assertEqual(module.patch_html(after), after)

    def test_page_without_newsletter_stays_identical(self):
        source = '<html><main>Unchanged content</main><script src="other.js?v=old"></script></html>'
        self.assertEqual(module.patch_html(source), source)

    def test_only_two_explicit_privacy_paragraphs_change(self):
        source = '<main>Keep this.</main><p class="card-text">Für den technischen Betrieb des Wirkungsportals old.</p><p>Nach erfolgreicher Newsletter-Bestätigung old.</p><footer>Keep this too.</footer>'
        replacement = '<p>Für den technischen Betrieb des Wirkungsportals new.</p><p>Der bestehende Newsletter-Bestätigungsweg new.</p>'
        result = module.patch_html(source, privacy_source=replacement)
        self.assertEqual(result, '<main>Keep this.</main>' + replacement + '<footer>Keep this too.</footer>')
        with self.assertRaises(ValueError):
            module.patch_html(source + source, privacy_source=replacement)


if __name__ == '__main__':
    unittest.main()
