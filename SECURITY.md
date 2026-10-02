# Security

## Supported versions

Security fixes target the latest released minor version. Pre-release candidates
receive fixes before release; update to the latest patch within your minor.

| Version                         | Security fixes              |
| ------------------------------- | --------------------------- |
| Latest released minor           | Supported                   |
| Release candidate of next minor | Fixed before release        |
| Older minors                    | Upgrade to the latest minor |

## Data and credentials

AGI IS HERE runs in the browser. Your provider key is stored in localStorage
for the app's origin and sent to your chosen provider, OpenAI or Anthropic.
Production calls the provider directly; the development server proxies requests
locally. Creating and remixing send relevant game source, messages, rendered
previews and authoring conversation to that provider. Provider calls use your
account and are subject to the provider's data handling policies.

Image generation sends the prompt and any selected reference images to the
OpenAI images API using your OpenAI key. Generated images stay in the project
and can become native PICTURE or VIEW resources. The request preview shows its
model, quality, size and estimated cost before sending.

Projects are saved in IndexedDB with a localStorage index.
**Settings → This game → Download game…** downloads authoring history and
images alongside the game; **Settings → This game → Export game…** downloads
playable resources and public metadata. API credentials are excluded from
both. Downloads are local files; sharing them is a separate action.

## Trust boundaries

- Scripts on the app's origin can access its localStorage, including API keys.
  Production uses the separate `agi.monotio.com` origin, so other monotio.com sites
  cannot directly read its localStorage or IndexedDB. Scripts and dependencies
  served by the app itself remain trusted. Use a revocable key with an
  appropriate spending limit.
- Game files and model responses are untrusted inputs. Resource readers, tool
  schemas and the assembler validate them before use. The worker interprets
  AGI bytecode through defined opcodes rather than executing it as JavaScript.
- Diagnostic exports can include game content and authoring conversations.
  Review them before attaching them to an issue.

The shipped [CSP and security headers](app/staticwebapp.config.json) restrict
scripts and workers to the app origin and provider connections to OpenAI and
Anthropic. Self-hosters should apply these headers; see [hosting](docs/hosting.md).

`AGI_DEV_KEYS` is a development-only convenience for provider keys from the
local environment. Vite serves it only to loopback requests in development;
production builds exclude it. Enable it only for your own local development
session, as described in [development setup](CONTRIBUTING.md#development).

## Reporting a vulnerability

Report through [GitHub private vulnerability reporting](https://github.com/monotio/agi/security/advisories/new)
(**Security → Report a vulnerability**). Include the affected version, steps,
impact and a small reproduction. Keep API keys and private game transcripts out
of reports. Security concerns belong in this private channel.

Maintainers aim to acknowledge reports within seven days and provide an initial
assessment within fourteen days. These are response targets for a volunteer
project. We coordinate a fix and disclosure with the reporter and share progress
in the private report.

## Release controls

Production releases require a PR merged by `@joakimriedel` into protected `main`
and successful CI. External PRs do not receive deployment credentials. Actions use
read-only tokens by default and immutable action references; secret scanning,
push protection, Dependabot security updates and private vulnerability reporting
are enabled in the repository settings. Account and organization administrators
can change these controls; this is not a substitute for securing those accounts.
