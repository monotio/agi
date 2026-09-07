# Hosting

Run `npm run build` and serve `app/dist` over HTTPS. Set these response headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

For a subpath such as `/agi/`, build with:

```bash
npm --prefix app run build -- --base=/agi/
```

The worker bridge requires cross-origin isolation for `SharedArrayBuffer`.
Check the headers, worker loading, ZIP import and provider connections on the
actual host. Production calls providers directly; the development server proxies
those requests locally.

## Including games on your site

The bundled tutorial needs no setup. To offer additional games you have permission
to redistribute, put their public AGI resources under `app/public/games/<id>/`
and add an entry to `app/public/catalog.json` before building. You can also upload
these folders and the manifest directly beside a deployed `index.html`.

```json
{
  "format": "monotio.agi.catalog",
  "version": 1,
  "games": [
    {
      "id": "garden",
      "version": "1.0.0",
      "title": "The Garden",
      "description": "An afternoon in an unusual garden.",
      "author": "Your studio",
      "license": "MIT",
      "path": "games/garden/",
      "files": [
        "LOGDIR",
        "PICDIR",
        "VIEWDIR",
        "SNDDIR",
        "VOL.0",
        "WORDS.TOK",
        "OBJECT",
        "GAME.JSON"
      ]
    }
  ]
}
```

List the actual filenames, preserving their case; optional files such as
`GAME.JSON` should only be listed if present. Use the game's actual license and
keep its required attribution and license files alongside the published game.
The manifest fetches only declared public AGI files, never `PROJECT.JSON` or
authoring conversations. Paths are relative to the manifest on the same origin,
including when the app is hosted under a subpath.

Each entry appears in **Your games** with a checked opening screenshot and **Play**.
The opening check runs when its card comes into view and reports missing or broken
resources before play. Playing stores that release in the browser; subsequent
visits use its saved copy and checkpoint. Change the entry's version when publishing
changed resources so an existing player's saved release stays intact.

## Production releases

Production is served at `https://agi.monotio.com/` through Azure Front Door.
CI builds with `/` as the base and packages only `app/dist` plus the
static-host response configuration. Separate Chromium and WebKit jobs check that
artifact with `npm --prefix app run e2e:production`; the development browser
suites also run independently, so one browser failure cannot skip the other.
Browser failures retain traces for diagnosis. Fixture games are never deployment inputs.

Only `@joakimriedel` may merge into protected `main`. Pull requests and the
required CI checks apply to administrators too; direct pushes, force pushes,
auto-merge and branch deletion are disabled. Self-authored PRs do not require a
second account's approval. CODEOWNERS identifies ownership; the branch push
restriction is what enforces exclusive merge permission. An organization owner
can still change GitHub's settings, so account security remains essential.

A successful push to `main` publishes the artifact from that same CI run after
all check and browser jobs pass. PR jobs have read-only repository access and no production
identity. Outside contributors' workflows require approval. Production is a
main-only GitHub environment, uses OIDC bound to immutable GitHub owner/repository IDs, and has only these
environment secrets:
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
`AZURE_RESOURCE_GROUP`, `AZURE_STATIC_WEB_APP_NAME`, `FRONT_DOOR_ID`, and
`FRONT_DOOR_HOST`. These identify infrastructure; no long-lived Azure login
secret or provider API key is stored. The upload token is fetched at runtime
and masked. Public workflow logs are public: never print Azure deployment
objects, tokens or private parameters in this repository.

Front Door, DNS, production parameters and the publisher identity are
managed with Bicep in the private Monotio web infrastructure repository. The
publisher can read only the AGI site's deployment token, not change DNS, roles,
Front Door or the portfolio. The origin accepts traffic only from our gateway.
The app's HTML is not cached; hashed assets receive immutable caching.

Verify the actual edge with:

```bash
AGI_DEPLOY_URL=https://agi.monotio.com npm --prefix app run e2e:production
```

Release rollback is a revert PR through the same checks. Re-running CI also
rebuilds its commit; do not re-run an older release job to roll back production.
An urgent publishing stop is available by disabling the CI workflow or removing
the production identity's federation in Azure. Neither action purges already
served files. Front Door traffic is metered; rate limiting is not a spending cap.
