"""Reject hidden private content in an intermediate outgoing commit."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/quality'))
import check_public_push as push
import test_public_history


class PublicPushTests(unittest.TestCase):
    def test_removed_private_file_in_intermediate_commit_is_still_blocked(self):
        helper = test_public_history.PublicHistoryTests()
        with tempfile.TemporaryDirectory() as folder:
            root = helper.setup_repo(folder)
            helper.commit(root, marker=True)
            base = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
            path = root / 'draft.txt'
            path.write_text('/' + 'Users/test-person/private-document')
            subprocess.run(['git', 'add', 'draft.txt'], cwd=root, check=True)
            subprocess.run(['git', 'commit', '-qm', 'draft'], cwd=root, check=True)
            path.unlink()
            subprocess.run(['git', 'commit', '-qam', 'remove draft'], cwd=root, check=True)
            tip = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
            self.assertIn('private-home-path', push.verify(root, f'refs/heads/main {tip} refs/heads/main {base}'))


if __name__ == '__main__':
    unittest.main()
