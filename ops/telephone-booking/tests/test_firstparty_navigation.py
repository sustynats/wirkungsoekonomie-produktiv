"""Test only the isolated confirmation page against the real navigation gate."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location("booking_navigation_report",ROOT/"scripts/quality/navigation-report.py")
report=importlib.util.module_from_spec(spec);spec.loader.exec_module(report)
REL="w/natalie-weber/anfrage-bestaetigen/index.html"
SHELL=(ROOT/REL).read_text()

class IsolatedBookingNavigation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        (self.root/"index.html").write_text('<html lang="de"><main>Home</main><footer>Global footer</footer></html>')
        self.before=report.measure(self.root)
    def tearDown(self):self.temp.cleanup()
    def put(self,html,rel=REL):
        f=self.root/rel;f.parent.mkdir(parents=True,exist_ok=True);f.write_text(html)
    def test_actual_generated_shell_keeps_all_navigation_gates_green(self):
        self.put(SHELL);after=report.measure(self.root)
        self.assertEqual(report.regressions(self.before,after),[])
        self.assertEqual(after['counts']['withoutFooter'],0)
        self.assertEqual(after['variants']['footer'],self.before['variants']['footer'])
        self.assertEqual(after['counts']['contentHtml'],2)
    def test_marker_loss_on_exact_route_is_rejected(self):
        for marker in ['<meta name="woek-booking-verification">','<meta name="robots" content="noindex, nofollow, noarchive">','<meta name="referrer" content="no-referrer">']:
            with self.subTest(marker=marker):
                self.put(SHELL.replace(marker,''))
                with self.assertRaisesRegex(ValueError,'ISOLATION_MARKERS_REQUIRED'):report.measure(self.root)
    def test_other_noindex_page_still_counts_as_footer_variant(self):
        self.put(SHELL,'another-service/index.html');after=report.measure(self.root)
        self.assertTrue(any('footer/de:' in x for x in report.regressions(self.before,after)))
    def test_missing_footer_is_not_exempted(self):
        import re
        self.put(re.sub(r'<footer>[\s\S]*?</footer>','',SHELL));after=report.measure(self.root)
        self.assertEqual(after['counts']['withoutFooter'],1)
        self.assertTrue(any('withoutFooter:' in x for x in report.regressions(self.before,after)))
if __name__=='__main__':unittest.main(verbosity=2)
