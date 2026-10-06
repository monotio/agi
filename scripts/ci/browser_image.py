"""Validate the pinned browser image and the package restored by CI."""
import argparse
import json
from pathlib import Path
import re
import sys

PIN = Path('scripts/ci/playwright-image.txt')


def image_ref(ref):
    match = re.fullmatch(r'mcr\.microsoft\.com/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[0-9a-f]{64}', ref)
    if not match:
        raise ValueError('Use a versioned Noble image pinned by digest in scripts/ci/playwright-image.txt')
    return match.group(1)


def check_version(ref, package, marker):
    version = image_ref(ref)
    installed = json.loads(package.read_text())['version']
    if version != installed:
        raise ValueError(f'Playwright image is {version}; installed playwright-core is {installed}. '
                         'Update scripts/ci/playwright-image.txt to the matching Noble tag and digest.')
    if not marker.is_file():
        raise ValueError('Playwright container metadata is missing. Run browser jobs in the pinned Playwright image.')
    actual = json.loads(marker.read_text())
    if actual.get('driverVersion') != version or actual.get('dockerImageName') != ref.split('@')[0]:
        raise ValueError(f'Playwright actual container metadata disagrees with {ref}: {actual}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--print', action='store_true', dest='print_ref')
    args = parser.parse_args()
    try:
        ref = PIN.read_text().strip()
        image_ref(ref)
        if args.print_ref:
            print(ref)
        else:
            check_version(ref, Path('app/node_modules/playwright-core/package.json'),
                          Path('/ms-playwright/.docker-info'))
            print(f'Playwright package and container match: {ref}')
    except (ValueError, OSError, KeyError) as error:
        print(f'::error::{error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
