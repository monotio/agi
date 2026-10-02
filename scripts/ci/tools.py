"""CI selection, duration balancing and repeat-run reporting (standard library only)."""
import argparse
from collections import defaultdict
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import tempfile

BENCHMARK = "history-bench.spec.ts"


def classify(files, exists=Path.is_file):
    # Capture programs affect browser behavior even when kept beside documentation.
    code = {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '.html', '.vue'}
    docs_only = bool(files) and all(
        path.endswith('.md') or (path.startswith('docs/') and Path(path).suffix not in code)
        for path in files)
    specs = sorted(path for path in files
                   if path.startswith(('app/e2e/', 'app/production/'))
                   and path.endswith('.spec.ts') and exists(Path(path)))
    return {'browsers': not docs_only, 'specs': specs}


def partition(files, weights, count):
    if count < 1:
        raise ValueError('Shard count must be positive')
    fallback = statistics.median(weights.values()) if weights else 10
    buckets = [[] for _ in range(count)]
    totals = [0.0] * count
    for file in sorted(set(files), key=lambda file: (-weights.get(file, fallback), file)):
        shard = min(range(count), key=lambda index: (totals[index], index))
        buckets[shard].append(file)
        totals[shard] += weights.get(file, fallback)
    return buckets


def specs_in(report):
    def walk(suite):
        yield from suite.get('specs', [])
        for child in suite.get('suites', []):
            yield from walk(child)
    for suite in report.get('suites', []):
        yield from walk(suite)


def intermittent(reports):
    counts = defaultdict(lambda: {'passed': 0, 'failed': 0})
    for report in reports:
        for spec in specs_in(report):
            for test in spec.get('tests', []):
                location = spec['file'] + (f":{spec['line']}" if 'line' in spec else '')
                project = test.get('projectName') or report.get('_ci_suite', 'chromium')
                name = f"{project} · {location} · {spec['title']}"
                for result in test.get('results', []):
                    status = result['status']
                    if status == 'skipped':
                        continue
                    outcome = 'passed' if status == test.get('expectedStatus', 'passed') else 'failed'
                    counts[name][outcome] += 1
    return [{'test': name, **count} for name, count in sorted(counts.items())
            if count['passed'] and count['failed']]


def changed_files(base, head):
    return subprocess.check_output(
        ['git', 'diff', '--name-only', '-z', base, head]).decode().strip('\0').split('\0')


def changes(args):
    files = changed_files(args.base, args.head) if args.base and set(args.base) != {'0'} else []
    result = classify([file for file in files if file])
    output = f"browsers={str(result['browsers']).lower()}\nspecs={json.dumps(result['specs'])}\n"
    print(output, end='')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as file:
            file.write(output)


def playwright(command, report, extra):
    env = {**os.environ, 'PLAYWRIGHT_JSON_OUTPUT_FILE': str(Path(report).resolve())}
    Path(report).parent.mkdir(parents=True, exist_ok=True)
    return subprocess.run(['npm', '--prefix', 'app', 'run', command, '--',
                           '--reporter=list,json', f'--output=test-results/{Path(report).stem}', *extra], env=env).returncode


def file_filter(file):
    return r'(?:^|/)' + re.escape(file) + '$'


def discover(suite="chromium"):
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'discovery.json'
        env = {**os.environ, 'PLAYWRIGHT_JSON_OUTPUT_FILE': str(output)}
        selection = (['--config', 'playwright.webkit.config.ts'] if suite == 'webkit'
                     else ['--grep-invert', '@perf'])
        subprocess.run(
            ['npm', 'exec', '--', 'playwright', 'test', *selection, '--list',
             '--reporter=json'], cwd='app', env=env, check=True, stdout=subprocess.DEVNULL)
        return json.loads(output.read_text())


def split_discovery(report, suite):
    files = sorted({spec['file'] for spec in specs_in(report)})
    isolated = [file for file in files if suite == 'chromium' and file == BENCHMARK]
    return [file for file in files if file not in isolated], isolated


def isolated(args):
    _, files = split_discovery(discover(), 'chromium')
    if files != [BENCHMARK]:
        raise RuntimeError('Storage benchmark missing from discovery')
    return playwright('e2e', args.report,
                      [*[file_filter(file) for file in files], '--workers=1',
                       f'--repeat-each={args.repeat}'])


def shard(args):
    # Discover tests through Playwright so new specs are always included and config filters apply.
    report = discover(args.suite)
    files, _ = split_discovery(report, args.suite)
    weights = json.loads(Path('scripts/ci/' +
                             ('webkit-durations.json' if args.suite == 'webkit' else 'durations.json')).read_text())
    buckets = partition(files, weights, args.count)
    selected = buckets[args.index - 1]
    print(f'Shard {args.index}/{args.count}: {len(selected)} specs', flush=True)
    if not selected:
        raise RuntimeError('Empty shard: adjust shard count')
    # Playwright treats file arguments as regular expressions.
    return playwright('e2e:webkit-desktop' if args.suite == 'webkit' else 'e2e', args.report,
                      [file_filter(file) for file in selected] +
                      [f'--repeat-each={args.repeat}'])


def burn(args):
    files = json.loads(args.specs)
    e2e = [file_filter(path.removeprefix('app/')) for path in files
           if path.startswith('app/e2e/')]
    production = [file_filter(path.removeprefix('app/')) for path in files
                  if path.startswith('app/production/')]
    result = 0
    repeat = ['--repeat-each=5']
    if args.browser == 'chromium' and f'app/e2e/{BENCHMARK}' in files:
        benchmark_filter = file_filter(f'e2e/{BENCHMARK}')
        e2e = [pattern for pattern in e2e if pattern != benchmark_filter]
        result |= playwright('e2e', 'app/test-results/ci-reports/burn-benchmark.json',
                             [benchmark_filter, *repeat, '--workers=1'])
    if e2e:
        command = 'e2e' if args.browser == 'chromium' else 'e2e:webkit-desktop'
        result |= playwright(command, f'app/test-results/ci-reports/burn-{args.browser}.json',
                             [*e2e, *repeat, '--pass-with-no-tests'])
        if args.browser == 'chromium':
            result |= playwright('e2e:perf', 'app/test-results/ci-reports/burn-perf.json',
                                 [*e2e, *repeat, '--pass-with-no-tests'])
    if production:
        result |= playwright('e2e:production', f'app/test-results/ci-reports/burn-production-{args.browser}.json',
                             [*production, *repeat, f'--browser={args.browser}'])
    return result


def issue(args):
    paths = sorted(Path(args.directory).rglob('*.json'))
    if not paths:
        raise RuntimeError('No repeat-run reports downloaded')
    reports = [{**json.loads(path.read_text()), '_ci_suite': re.sub(r'-\d+$', '', path.stem)}
               for path in paths]
    flakes = intermittent(reports)
    marker = '<!-- browser-repeat-flakes -->'
    body = [marker, 'Browser tests with both passing and failing attempts in the latest nightly run.',
            '', f'[Run and artifacts]({args.url})', f'Reports available: {len(paths)}.', '']
    body += [f"- `{item['test']}`: {item['passed']} passed, {item['failed']} failed."
             for item in flakes] or ['Every completed test had consistent results.']
    Path(args.body).write_text('\n'.join(body) + '\n')
    if args.dry_run:
        return 0
    issues = json.loads(subprocess.check_output(
        ['gh', 'issue', 'list', '--repo', args.repo, '--state', 'all', '--search',
         '"Nightly browser flakes" in:title', '--json', 'number,body,state', '--limit', '100']))
    existing = next((item for item in issues if marker in item['body']), None)
    if existing:
        subprocess.run(['gh', 'issue', 'edit', str(existing['number']), '--repo', args.repo,
                        '--body-file', args.body], check=True)
        if flakes and existing['state'] == 'CLOSED':
            subprocess.run(['gh', 'issue', 'reopen', str(existing['number']), '--repo', args.repo], check=True)
    elif flakes:
        subprocess.run(['gh', 'issue', 'create', '--repo', args.repo,
                        '--title', 'Nightly browser flakes', '--body-file', args.body], check=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    change = commands.add_parser('changes')
    change.add_argument('--base', default='')
    change.add_argument('--head', default='HEAD')
    balance = commands.add_parser('shard')
    balance.add_argument('--index', type=int, required=True)
    balance.add_argument('--suite', choices=['chromium', 'webkit'], default='chromium')
    balance.add_argument('--count', type=int, default=10)
    balance.add_argument('--repeat', type=int, default=1)
    balance.add_argument('--report', required=True)
    quiet = commands.add_parser('isolated')
    quiet.add_argument('--repeat', type=int, default=1)
    quiet.add_argument('--report', required=True)
    burn_in = commands.add_parser('burn')
    burn_in.add_argument('--specs', required=True)
    burn_in.add_argument('--browser', choices=['chromium', 'webkit'], required=True)
    flake_issue = commands.add_parser('issue')
    flake_issue.add_argument('--directory', required=True)
    flake_issue.add_argument('--url', required=True)
    flake_issue.add_argument('--repo', default=os.environ.get('GITHUB_REPOSITORY'))
    flake_issue.add_argument('--body', default='/tmp/browser-flakes.md')
    flake_issue.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    if args.command == 'changes':
        changes(args)
        return 0
    return {'shard': shard, 'isolated': isolated, 'burn': burn, 'issue': issue}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
