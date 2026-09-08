# Security

## Data and credentials

AGI IS HERE runs in the browser. Your provider key is stored in localStorage
for the app's origin and sent to your chosen provider, OpenAI or Anthropic.
Production calls the provider directly; the development server proxies requests
locally. Creating and remixing send relevant game source, messages, rendered
previews and authoring conversation to that provider. Provider calls use your
account and are subject to the provider's data handling policies.

Projects are saved in IndexedDB with a localStorage index.
**Game actions → Project** downloads authoring history and images alongside the
game; **Game actions → Game export** downloads playable resources and public
metadata. API credentials are excluded from both. Downloads are local files;
sharing them is a separate action.

## Trust boundaries

- Scripts on the app's origin can access its localStorage, including API keys.
  Production uses the separate `agi.monotio.com` origin, so portfolio pages
  cannot directly read its localStorage or IndexedDB. Scripts and dependencies
  served by the game itself remain trusted. Use a revocable key with an
  appropriate spending limit.
- Game files and model responses are untrusted inputs. Resource readers, tool
  schemas and the assembler validate them before use. The worker interprets
  AGI bytecode through defined opcodes rather than executing it as JavaScript.
- Diagnostic exports can include game content and authoring conversations.
  Review them before attaching them to an issue.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting when available (Security → Report a vulnerability),
or contact the maintainers through the Monotio GitHub organization. Do not
include API keys or private game transcripts in public reports.

## Release controls

Production releases require a PR merged by `@joakimriedel` into protected `main`
and successful CI. External PRs do not receive deployment credentials. Actions use
read-only tokens by default and immutable action references; secret scanning,
push protection, Dependabot security updates and private vulnerability reporting
are enabled in the repository settings. Account and organization administrators
can change these controls; this is not a substitute for securing those accounts.
