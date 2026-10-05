import json
from pathlib import Path
import tempfile
import unittest

from browser_image import image_ref, check_version


class BrowserImage(unittest.TestCase):
    def test_requires_a_versioned_noble_image_and_digest(self):
        for ref in ['mcr.microsoft.com/playwright:latest',
                    'mcr.microsoft.com/playwright:v1.63.0-noble',
                    'mcr.microsoft.com/playwright:v1.63.0-jammy@sha256:' + 'a' * 64]:
            with self.assertRaisesRegex(ValueError, 'versioned Noble image pinned by digest'):
                image_ref(ref)

    def test_checks_installed_package_and_actual_image(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory, 'package.json')
            marker = Path(directory, '.docker-info')
            package.write_text(json.dumps({'version': '1.63.0'}))
            ref = 'mcr.microsoft.com/playwright:v1.63.0-noble@sha256:' + 'a' * 64
            marker.write_text(json.dumps({'driverVersion': '1.63.0',
                                         'dockerImageName': ref.split('@')[0]}))
            check_version(ref, package, marker)
            package.write_text(json.dumps({'version': '1.64.0'}))
            with self.assertRaisesRegex(ValueError, 'installed playwright-core is 1.64.0.*Update scripts/ci/playwright-image.txt'):
                check_version(ref, package, marker)
            package.write_text(json.dumps({'version': '1.63.0'}))
            marker.write_text(json.dumps({'driverVersion': '1.62.0',
                                         'dockerImageName': 'mcr.microsoft.com/playwright:v1.62.0-noble'}))
            with self.assertRaisesRegex(ValueError, 'actual container'):
                check_version(ref, package, marker)
            marker.unlink()
            with self.assertRaisesRegex(ValueError, 'Playwright container metadata is missing'):
                check_version(ref, package, marker)


if __name__ == '__main__':
    unittest.main()
