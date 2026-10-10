import re
import json
import math
import os
import subprocess
from pathlib import Path
import tempfile
from unittest.mock import patch
import unittest
from types import SimpleNamespace

from tools import classify, changed_files, partition, intermittent, file_filter, discover, split_discovery, issue


class Changes(unittest.TestCase):
    def test_docs_and_media_assets_skip_browsers(self):
        self.assertFalse(classify(['README.md', 'docs/media/play.png'])['browsers'])
        self.assertFalse(classify(['guide.md', 'docs/testing.md'])['browsers'])
        self.assertEqual(classify(['README.md'])['quality'], 'docs')

    def test_capture_code_and_empty_diff_run_browsers(self):
        for files in [[], ['docs/media/capture.ts'], ['docs/media/capture.py'],
                      ['docs/example.json'], ['app/src/App.vue'], ['app/src/help/content.md'],
                      ['.github/workflows/ci.yml'], ['scripts/ci/playwright-image.txt'],
                      ['package-lock.json'], ['scripts/ci/new-helper.py']]:
            self.assertTrue(classify(files)['browsers'])
            self.assertEqual(classify(files)['quality'], 'full')

    def test_known_ci_helpers_use_their_own_gate(self):
        files = ['scripts/ci/tools.py', 'scripts/ci/test_tools.py', 'docs/testing.md']
        self.assertEqual(classify(files), {'browsers': False, 'quality': 'ci'})
        self.assertEqual(classify(files + ['src/runtime/engine.ts'])['quality'], 'full')

    def test_test_only_changes_keep_full_coverage(self):
        for file in ['test/fixtures.test.ts', 'app/test/game-library.test.ts',
                     'app/e2e/workspace-launch.spec.ts', 'app/production/smoke.spec.ts']:
            self.assertEqual(classify([file]), {'browsers': True, 'quality': 'full'})

    def test_renaming_code_to_documentation_keeps_the_code_deletion_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(
                    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', *args],
                    cwd=directory, stderr=subprocess.DEVNULL)
            git('init')
            Path(directory, 'engine.ts').write_text('original code\n')
            git('add', '.')
            git('commit', '-m', 'Initial fixture')
            git('mv', 'engine.ts', 'guide.md')
            git('commit', '-m', 'Move fixture')
            read = subprocess.check_output
            with patch('tools.subprocess.check_output',
                       side_effect=lambda command: read(command, cwd=directory)):
                files = changed_files('HEAD~', 'HEAD')
            self.assertIn('engine.ts', files)
            self.assertEqual(classify(files)['quality'], 'full')


class Shards(unittest.TestCase):
    def test_recorded_weights_are_finite_nonnegative_numbers(self):
        for filename in ['durations.json', 'webkit-durations.json']:
            weights = json.loads(Path(__file__).with_name(filename).read_text())
            self.assertTrue(weights)
            for name, seconds in weights.items():
                with self.subTest(file=filename, spec=name):
                    self.assertEqual(Path(name).name, name)
                    self.assertTrue(name.endswith('.spec.ts'))
                    self.assertIsInstance(seconds, (int, float))
                    self.assertTrue(math.isfinite(seconds) and seconds >= 0)

    def test_discovery_keeps_the_run_report_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            run_report = Path(directory) / 'run.json'
            run_report.write_text('original run report')
            report = {'suites': [{'specs': [{'file': 'new.spec.ts'}]}]}

            def fake_playwright(*args, **kwargs):
                env = kwargs.get('env', os.environ)
                Path(env['PLAYWRIGHT_JSON_OUTPUT_FILE']).write_text(json.dumps(report))
                return b''

            with patch.dict(os.environ, {'PLAYWRIGHT_JSON_OUTPUT_FILE': str(run_report)}), \
                    patch('tools.subprocess.check_output', side_effect=fake_playwright), \
                    patch('tools.subprocess.run', side_effect=fake_playwright):
                self.assertEqual(discover(), report)
                self.assertEqual(run_report.read_text(), 'original run report')


    def test_filters_select_exact_files_with_similar_names(self):
        pattern = re.compile(file_filter('menu-flow.spec.ts'))
        self.assertTrue(pattern.search('/repo/app/e2e/menu-flow.spec.ts'))
        self.assertFalse(pattern.search('/repo/app/e2e/studio-menu-flow.spec.ts'))


    def test_isolated_benchmark_and_shards_keep_every_file(self):
        report = {'suites': [{'specs': [{'file': file} for file in
                  ['history-bench.spec.ts', 'ordinary.spec.ts', 'new.spec.ts']]}]}
        ordinary, isolated = split_discovery(report, 'chromium')
        self.assertEqual(ordinary, ['new.spec.ts', 'ordinary.spec.ts'])
        self.assertEqual(isolated, ['history-bench.spec.ts'])
        self.assertEqual(split_discovery(report, 'webkit'),
                         (['history-bench.spec.ts', 'new.spec.ts', 'ordinary.spec.ts'], []))

    def test_balances_durations_and_keeps_every_file_once(self):
        buckets = partition(['a', 'b', 'c', 'd', 'e', 'f'],
                            {'a': 12, 'b': 11, 'c': 10, 'd': 3, 'e': 2, 'f': 1}, 3)
        self.assertEqual(buckets, [['a', 'f'], ['b', 'e'], ['c', 'd']])
        self.assertEqual(sorted(sum(buckets, [])), list('abcdef'))

    def test_new_specs_receive_a_weight_and_stable_assignment(self):
        self.assertEqual(partition(['new', 'known'], {'known': 10}, 2),
                         partition(['known', 'new'], {'known': 10}, 2))


class Flakes(unittest.TestCase):
    def test_group_ten_merges_with_other_chromium_groups(self):
        with tempfile.TemporaryDirectory() as directory:
            for index, status in [(1, 'passed'), (10, 'failed')]:
                report = {'suites': [{'specs': [{'file': 'a.spec.ts', 'title': 'mixed',
                          'tests': [{'results': [{'status': status}]}]}]}]}
                Path(directory, f'chromium-{index}.json').write_text(json.dumps(report))
            body = Path(directory, 'issue.md')
            with patch('builtins.print'):
                issue(SimpleNamespace(directory=directory, body=str(body),
                                      url='https://example.test/run', dry_run=True))
            self.assertIn('chromium · a.spec.ts · mixed', body.read_text())

    def test_reports_only_mixed_results_across_repetitions(self):
        def spec(title, statuses, expected='passed'):
            return {'file': 'e2e/a.spec.ts', 'title': title,
                    'tests': [{'projectName': 'chromium', 'expectedStatus': expected,
                               'results': [{'status': status}]} for status in statuses]}
        report = {'suites': [{'specs': [spec('mixed', ['passed', 'failed', 'passed']),
                                      spec('broken', ['failed', 'failed']),
                                      spec('good', ['passed', 'passed']),
                                      spec('skipped', ['skipped']),
                                      spec('expected failure', ['failed', 'failed'], 'failed')]}]}
        self.assertEqual(intermittent([report]),
                         [{'test': 'chromium · e2e/a.spec.ts · mixed', 'passed': 2, 'failed': 1}])

    def test_identical_titles_at_different_lines_are_separate_tests(self):
        report = {'suites': [{'specs': [
            {'file': 'a.spec.ts', 'line': line, 'title': 'same',
             'tests': [{'results': [{'status': status}]}]}
            for line, status in [(10, 'passed'), (20, 'failed')]]}]}
        self.assertEqual(intermittent([report]), [])

    def test_merges_repeated_specs_and_nested_suites(self):
        def report(status):
            return {'suites': [{'suites': [{'specs': [{'file': 'e2e/a.spec.ts', 'title': 'test',
                    'tests': [{'projectName': 'webkit', 'results': [{'status': status}]}]}]}]}]}
        self.assertEqual(len(intermittent([report('passed'), report('timedOut')])), 1)


if __name__ == '__main__':
    unittest.main()
