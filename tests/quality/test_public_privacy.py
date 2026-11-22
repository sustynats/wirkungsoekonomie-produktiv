"""Regression cases for hidden and visible private filesystem references."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("privacy", ROOT / "scripts/quality/public_privacy.py")
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


class PublicationPrivacyTests(unittest.TestCase):
    def test_real_web_source_is_not_a_home_directory(self):
        self.assertEqual(privacy.text_issues("https://example.org/home/supporting-material/taxonomy/"), set())

    def test_percent_encoded_home_path_is_detected(self):
        value = "%2F" + "Users%2Ftest-person%2Fprivate-document.docx"
        self.assertIn("private-home-path", privacy.text_issues(value))

    def test_shell_default_cannot_hide_a_private_home(self):
        value = '${SOURCE:-/' + 'home/test-person/private-file}'
        self.assertIn("private-home-path", privacy.text_issues(value, source_code=True))

    def test_encoded_and_escaped_paths_are_detected(self):
        for value in ["%252F" + "Users%252Ftest-person%252Fdraft", "&#47;" + "Users&#47;test-person&#47;draft", "\\/" + "Users\\/test-person\\/draft"]:
            self.assertIn("private-home-path", privacy.text_issues(value))

    def test_pattern_definitions_and_public_web_paths_are_allowed(self):
        self.assertEqual(privacy.text_issues(r"(?:file:|/Users/|C:\\Users\\)", source_code=True), set())
        self.assertEqual(privacy.text_issues("Ein HTTP-Server, kein `file://`."), set())

    def test_embedded_image_metadata_is_checked(self):
        import io
        from PIL import Image, PngImagePlugin

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "example.docx"
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("Source", "/" + "Users/test-person/source.png")
            buffer = io.BytesIO()
            Image.new("RGB", (2, 2)).save(buffer, format="PNG", pnginfo=metadata)
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("word/media/image1.png", buffer.getvalue())
            self.assertIn("private-home-path", privacy.inspect_file(path))

    def test_media_probe_location_is_distinct_from_embedded_metadata(self):
        private = "/" + "Users/test-person/audio.mp3"
        for tags, expected in [({}, set()), ({"comment": private}, {"private-home-path"})]:
            result = SimpleNamespace(returncode=0, stdout=json.dumps({"format": {"filename": private, "tags": tags}}))
            with patch.object(privacy.subprocess, "run", return_value=result):
                self.assertEqual(privacy.inspect_file(Path("example.mp3")), expected)

    def test_nested_utf16_image_comment_is_checked(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "example.jpg"
            private = "/" + "Users/test-person/private-image.png"
            exif = Image.Exif()
            exif[34665] = {37510: b"UNICODE\x00" + private.encode("utf-16-le")}
            Image.new("RGB", (2, 2)).save(path, exif=exif)
            self.assertIn("private-home-path", privacy.inspect_file(path))

    def test_cli_reports_classes_without_repeating_private_values(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            private = "/" + "Users/test-person/private-draft.docx"
            (root / "public.html").write_text(private)
            result = subprocess.run([sys.executable, str(ROOT / "scripts/quality/public_privacy.py"), "--artifact", "--root", str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("private-home-path", result.stdout)
            self.assertNotIn(private, result.stdout + result.stderr)

    def test_unreadable_document_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "document.pdf").write_text("invalid PDF content")
            result = subprocess.run([sys.executable, str(ROOT / "scripts/quality/public_privacy.py"), "--artifact", "--root", str(root)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("file-cannot-be-verified", result.stdout)

    def test_office_hidden_core_properties_are_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "example.docx"
            private = "/" + "Users/test-person/private-document.docx"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("docProps/core.xml", f"<properties><source>{private}</source></properties>")
            self.assertIn("private-home-path", privacy.inspect_file(path))

    def test_pdf_hidden_metadata_and_file_link_are_checked(self):
        import pymupdf

        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "example.pdf"
            private = "/" + "Users/test-person/private-document.docx"
            with pymupdf.open() as document:
                page = document.new_page()
                page.insert_text((50, 50), "Public article text")
                document.set_metadata({"subject": private})
                page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(50, 60, 100, 80), "uri": "file:" + "//" + private})
                document.save(path)
            found = privacy.inspect_file(path)
            self.assertIn("private-home-path", found)
            self.assertIn("local-file-uri", found)


if __name__ == "__main__":
    unittest.main()
