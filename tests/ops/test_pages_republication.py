import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("republication", Path(__file__).parents[2] / "scripts/ops/prepare-pages-republication.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SHA = "a" * 40


class RepublicationTests(unittest.TestCase):
    def setUp(self):
        self.run = {"head_sha": SHA, "head_branch": "main", "path": ".github/workflows/deploy.yml", "status": "completed"}
        self.jobs = [{"name": name, "conclusion": "success"} for name in ("build", "release-assets")]
        self.artifact = {"name": "github-pages", "expired": False, "workflow_run": {"head_sha": SHA}, "digest": "sha256:" + "b" * 64}

    def validate(self):
        return MODULE.validate_source(self.run, self.jobs, [self.artifact], SHA)

    def test_passed_source_is_reusable(self):
        self.assertEqual(self.validate(), self.artifact)

    def test_failed_or_missing_source_gate_is_rejected(self):
        for jobs in ([self.jobs[0]], [{"name": name, "conclusion": "failure"} for name in ("build", "release-assets")]):
            with self.assertRaises(ValueError):
                MODULE.validate_source(self.run, jobs, [self.artifact], SHA)

    def test_wrong_or_running_source_is_rejected(self):
        for key, value in (("head_sha", "c" * 40), ("head_branch", "feature"), ("path", ".github/workflows/other.yml"), ("status", "in_progress")):
            run = {**self.run, key: value}
            with self.assertRaises(ValueError):
                MODULE.validate_source(run, self.jobs, [self.artifact], SHA)

    def test_expired_ambiguous_or_unverifiable_artifact_is_rejected(self):
        for artifacts in ([{**self.artifact, "expired": True}], [self.artifact, self.artifact], [{**self.artifact, "digest": ""}], [{**self.artifact, "workflow_run": {"head_sha": "d" * 40}}]):
            with self.assertRaises(ValueError):
                MODULE.validate_source(self.run, self.jobs, artifacts, SHA)

    def package(self, root, extra=None, domain="wirkungsoekonomie.de", extra_zip=False):
        tar = root / "fixture.tar"
        with tarfile.open(tar, "w") as archive:
            for name, data in (("./CNAME", domain.encode()), ("./index.html", b"<h1>test</h1>")):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra)
        package = root / "fixture.zip"
        with zipfile.ZipFile(package, "w") as archive:
            archive.write(tar, "artifact.tar")
            if extra_zip:
                archive.writestr("unexpected.txt", "test")
        artifact = {"size_in_bytes": package.stat().st_size, "digest": "sha256:" + hashlib.sha256(package.read_bytes()).hexdigest()}
        return package, artifact

    def test_archive_is_preserved_and_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package, artifact = self.package(root)
            proof = MODULE.verify_archive(package, artifact, root)
            self.assertEqual(proof["publicFiles"], 2)
            self.assertEqual((root / "artifact.tar").read_bytes(), (root / "fixture.tar").read_bytes())

    def test_digest_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            package, artifact = self.package(root)
            artifact["digest"] = "sha256:" + "0" * 64
            with self.assertRaises(ValueError):
                MODULE.verify_archive(package, artifact, root)

    def test_link_traversal_duplicate_and_wrong_domain_are_rejected(self):
        link = tarfile.TarInfo("linked")
        link.type = tarfile.SYMTYPE
        link.linkname = "index.html"
        for extra, domain, extra_zip in ((link, "wirkungsoekonomie.de", False), (tarfile.TarInfo("../outside"), "wirkungsoekonomie.de", False), (tarfile.TarInfo("./index.html"), "wirkungsoekonomie.de", False), (None, "other.example", False), (None, "wirkungsoekonomie.de", True)):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                package, artifact = self.package(root, extra, domain, extra_zip)
                with self.assertRaises(ValueError):
                    MODULE.verify_archive(package, artifact, root)


if __name__ == "__main__":
    unittest.main()
