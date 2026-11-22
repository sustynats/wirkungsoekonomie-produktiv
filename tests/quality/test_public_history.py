"""A prior private root must never enter the independent public source history."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/quality'))
import check_public_history as history


class PublicHistoryTests(unittest.TestCase):
    def setup_repo(self, folder):
        root = Path(folder)
        for args in [('init', '-q'), ('config', 'user.name', 'Publication Tests'), ('config', 'user.email', 'tests@example.org')]:
            subprocess.run(['git', *args], cwd=root, check=True, capture_output=True)
        return root

    def commit(self, root, marker=False, message='source'):
        if marker:
            p = root / history.MARKER
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps({'generation': history.GENERATION}))
        else:
            (root / 'example.txt').write_text('Public source')
        subprocess.run(['git', 'add', '.'], cwd=root, check=True, capture_output=True)
        subprocess.run(['git', 'commit', '-qm', message], cwd=root, check=True, capture_output=True)

    def test_clean_independent_root_is_accepted(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.setup_repo(folder)
            self.commit(root, marker=True)
            self.assertEqual(history.check(root), set())

    def test_marker_added_after_private_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.setup_repo(folder)
            self.commit(root)
            self.commit(root, marker=True)
            self.assertIn('unapproved-public-history-root', history.check(root))

    def test_path_in_commit_message_is_rejected_without_echoing_it(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.setup_repo(folder)
            self.commit(root, marker=True, message='Source from /' + 'Users/test-person/draft')
            self.assertIn('private-identifier-in-commit-metadata', history.check(root))

    def test_merging_the_private_root_back_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.setup_repo(folder)
            self.commit(root)
            private_branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=root, text=True).strip()
            for args in [('checkout', '--orphan', 'public-source'), ('rm', '-rf', '.')]:
                subprocess.run(['git', *args], cwd=root, check=True, capture_output=True)
            self.commit(root, marker=True)
            subprocess.run(['git', 'merge', '--allow-unrelated-histories', '--no-edit', private_branch], cwd=root, check=True, capture_output=True)
            self.assertIn('unrelated-private-history', history.check(root))

    def test_account_email_cannot_leak_through_automatic_commit_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = self.setup_repo(folder)
            subprocess.run(['git', 'config', 'user.email', 'private-person@provider.invalid'], cwd=root, check=True)
            self.commit(root, marker=True)
            self.assertIn('unapproved-commit-email', history.check(root))


if __name__ == '__main__':
    unittest.main()
