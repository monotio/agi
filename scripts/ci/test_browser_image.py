import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest

from browser_image import image_ref, check_version, check_webkit_libraries


class WebKitLibraries(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.library = self.root / 'webkit-2359/minibrowser-wpe/sys/lib/libsoup-3.0.so.0'
        self.library.parent.mkdir(parents=True)

    def test_rejects_the_bundled_network_process_crash_dependency(self):
        self.library.write_bytes(b'\x00libsoup/3.6.5\x00')
        with self.assertRaisesRegex(ValueError, 'libsoup 3.6.5.*network-process crash'):
            check_webkit_libraries(self.root)

    def test_accepts_the_upstream_fixed_library(self):
        self.library.write_bytes(b'\x00libsoup/3.6.6\x00')
        check_webkit_libraries(self.root)

    def test_checks_both_browser_ports(self):
        self.library.write_bytes(b'\x00libsoup/3.6.6\x00')
        gtk = self.root / 'webkit-2359/minibrowser-gtk/sys/lib/libsoup-3.0.so.0'
        gtk.parent.mkdir(parents=True)
        gtk.write_bytes(b'\x00libsoup/3.6.5\x00')
        with self.assertRaisesRegex(ValueError, 'libsoup 3.6.5'):
            check_webkit_libraries(self.root)

    def test_requires_inspectable_library_versions(self):
        with self.assertRaisesRegex(ValueError, 'WebKit libsoup libraries are missing'):
            check_webkit_libraries(self.root)
        self.library.write_bytes(b'unknown')
        with self.assertRaisesRegex(ValueError, 'Cannot identify libsoup'):
            check_webkit_libraries(self.root)


class BrowserImage(unittest.TestCase):
    def test_requires_a_versioned_noble_image_and_digest(self):
        for ref in ['mcr.microsoft.com/playwright:latest',
                    'mcr.microsoft.com/playwright:v1.63.0-noble',
                    'mcr.microsoft.com/playwright:v1.63.0-jammy@sha256:' + 'a' * 64]:
            with self.assertRaisesRegex(ValueError, 'versioned Noble image pinned by digest'):
                image_ref(ref)

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.package = self.root / 'node_modules/playwright-core/package.json'
        self.package.parent.mkdir(parents=True)
        self.marker = self.root / '.docker-info'
        self.ref = 'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:' + 'a' * 64
        self.package.write_text(json.dumps({'version': '1.63.0'}))
        self.marker.write_text(json.dumps({'driverVersion': '1.63.0',
                                          'dockerImageName': self.ref.split('@')[0]}))

    def test_accepts_matching_package_and_actual_image(self):
        check_version(self.ref, self.package, self.marker)

    def test_rejects_package_upgrade_with_an_update_instruction(self):
        self.package.write_text(json.dumps({'version': '1.64.0'}))
        with self.assertRaisesRegex(ValueError, 'installed playwright-core is 1.64.0.*Update scripts/ci/playwright-image.txt'):
            check_version(self.ref, self.package, self.marker)

    def test_rejects_actual_container_drift(self):
        self.marker.write_text(json.dumps({'driverVersion': '1.62.0',
                                          'dockerImageName': 'mcr.microsoft.com/playwright:v1.62.0-noble'}))
        with self.assertRaisesRegex(ValueError, 'actual container'):
            check_version(self.ref, self.package, self.marker)

    def test_rejects_wrong_image_tag_with_matching_driver(self):
        self.marker.write_text(json.dumps({'driverVersion': '1.63.0',
                                          'dockerImageName': 'mcr.microsoft.com/playwright:v1.63.0-jammy'}))
        with self.assertRaisesRegex(ValueError, 'actual container'):
            check_version(self.ref, self.package, self.marker)

    def test_rejects_missing_container_metadata(self):
        self.marker.unlink()
        with self.assertRaisesRegex(ValueError, 'Playwright container metadata is missing'):
            check_version(self.ref, self.package, self.marker)

    def test_cli_fails_the_job_on_package_upgrade(self):
        self.package.write_text(json.dumps({'version': '1.64.0'}))
        pin = self.root / 'scripts/ci/playwright-image.txt'
        pin.parent.mkdir(parents=True)
        pin.write_text(self.ref)
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('browser_image.py').resolve())],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('::error::Playwright image is 1.63.0; installed playwright-core is 1.64.0.', result.stderr)
        self.assertIn('Update scripts/ci/playwright-image.txt', result.stderr)


if __name__ == '__main__':
    unittest.main()
