import re
import unittest

from tools import classify, partition, intermittent, file_filter


class Changes(unittest.TestCase):
    def test_docs_and_media_assets_skip_browsers(self):
        self.assertFalse(classify(['README.md', 'docs/media/play.png'])['browsers'])
        self.assertFalse(classify(['guide.md', 'docs/testing.md'])['browsers'])

    def test_capture_code_and_empty_diff_run_browsers(self):
        for files in [[], ['docs/media/capture.ts'], ['docs/media/capture.py'],
                      ['app/src/App.vue'], ['.github/workflows/ci.yml']]:
            self.assertTrue(classify(files)['browsers'])

    def test_changed_specs_only_include_existing_specs(self):
        result = classify(['app/e2e/new.spec.ts', 'app/production/ship.spec.ts',
                           'app/e2e/helper.ts', 'app/e2e/deleted.spec.ts'],
                          exists=lambda path: 'deleted' not in str(path))
        self.assertEqual(result['specs'], ['app/e2e/new.spec.ts', 'app/production/ship.spec.ts'])


class Shards(unittest.TestCase):
    def test_filters_select_exact_files_with_similar_names(self):
        pattern = re.compile(file_filter('menu-flow.spec.ts'))
        self.assertTrue(pattern.search('/repo/app/e2e/menu-flow.spec.ts'))
        self.assertFalse(pattern.search('/repo/app/e2e/studio-menu-flow.spec.ts'))


    def test_balances_durations_and_keeps_every_file_once(self):
        buckets = partition(['a', 'b', 'c', 'd', 'e', 'f'],
                            {'a': 12, 'b': 11, 'c': 10, 'd': 3, 'e': 2, 'f': 1}, 3)
        self.assertEqual(buckets, [['a', 'f'], ['b', 'e'], ['c', 'd']])
        self.assertEqual(sorted(sum(buckets, [])), list('abcdef'))

    def test_new_specs_receive_a_weight_and_stable_assignment(self):
        self.assertEqual(partition(['new', 'known'], {'known': 10}, 2),
                         partition(['known', 'new'], {'known': 10}, 2))


class Flakes(unittest.TestCase):
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
