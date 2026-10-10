# Hosting

AGI IS HERE is a static web app: players' browsers
talk to their AI provider directly. Any static host that serves HTTPS can run a
copy.

## Building and serving

Run `npm ci` at the root, then `npm run build`, and serve `app/dist` over HTTPS. Copy the security and cache
headers from [app/staticwebapp.config.json](../app/staticwebapp.config.json):
CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and
`Cache-Control`. Keep `https://api.openai.com` and `https://api.anthropic.com` in
CSP `connect-src` so browser provider requests can reach them. The CSP permits
local workers, blob media and image previews, and restricts scripts to the app's
origin. Configure the `/assets/*` immutable cache rule alongside the default
`no-store` policy.

`node --experimental-strip-types scripts/serve-production.ts` serves `app/dist`
with those headers for local production checks (`AGI_E2E_PORT`, default 5299).

For a subpath such as `/agi/`, build with:

```bash
npm --prefix app run build -- --base=/agi/
```

Check worker loading, ZIP import and provider connections on the actual host.
Production calls providers directly; only the development server proxies those
requests locally.

## Including games on your site

The tutorial is included in the build. To offer additional games you have
permission to redistribute, put their public AGI resources under
`app/public/games/<id>/` and add an entry to `app/public/catalog.json` before
building. You can also upload these folders and the manifest directly beside a
deployed `index.html`.

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

- List the actual filenames, preserving their case. List optional files such as
  `GAME.JSON` only if they are present.
- Use the game's actual license, and keep its required attribution and license
  files alongside the published game.
- The manifest fetches only declared public AGI files, never `PROJECT.JSON` or
  authoring conversations.
- Paths are relative to the manifest on the same origin, including when the app
  is hosted under a subpath.

Each entry appears in **Your games** with a checked opening screenshot and
**Play**. The opening check runs when its card comes into view and reports
missing or broken resources before play. Playing stores that release in the
browser; later visits use the saved copy and checkpoint. Change the entry's
version when you publish changed resources, so an existing player's saved
release stays intact.

## Upgrading to 1.2

Existing 1.1 browser progress loads automatically in 1.2. The app adopts supported
autosaves, save slots and visited-room maps into storage identities tied to the
project lifetime or installed release, and retains the legacy records. Projects
and private archives retain version 1 with optional workspace and History data;
released recordings and recorded game tests remain readable through their
version migrations. See [project storage and archives](../CONTRIBUTING.md#how-it-fits-together)
for the format boundaries.

## Production releases

The public site at [agi.monotio.com](https://agi.monotio.com/) deploys from
`main`.

- Only the owner may merge into protected `main`, and the required CI checks
  apply to administrators too.
- A successful push to `main` builds the production artifact, checks it in
  separate Chromium and WebKit jobs (`npm --prefix app run e2e:production`) and
  deploys from that same CI run.
- The deploy job then checks that the public site serves that artifact: the
  index carries the commit's build identifier (`<meta name="agi-build">`) and
  the entry assets match the artifact's SHA-256 digests
  (`scripts/verify-deploy.ts`).
- Pull request jobs have no deployment access, and workflows from outside
  contributors require approval.
- Fixture games are never deployment inputs. Browser failures keep their traces
  for diagnosis.

### Release branches

`main` is what is live. Work for a minor release gathers on `release/X.Y`:

1. Each release candidate is a pull request from `rc/X.Y-rc.N` into
   `release/X.Y`, with the version in both `package.json` files set to
   `X.Y.0-rc.N`. It is squash-merged once CI passes and the owner accepts it.
2. When the release passes QA, bump both versions to `X.Y.0` on `release/X.Y`
   and open a pull request from `release/X.Y` into `main`. Merging it deploys.
3. Once the deploy job's build identity and asset digest check and the deployed
   browser suite pass, tag the `main` commit `vX.Y.0` and publish a
   GitHub Release on the tag, with the release pull request's description as
   its notes.
4. Delete `release/X.Y` after its `vX.Y.0` tag. Tags are permanent; the branch
   is temporary.

A patch release is a hotfix. It branches from the latest `main`, sets both
package versions to `X.Y.Z`, and merges into `main` through its own fully
checked pull request. There is no back-merge into a release branch. Verify
deployment before tagging `vX.Y.Z` and publishing its release notes. The next
minor release, `release/X.(Y+1)`, is cut from `main` when it starts.

To roll back, merge a fix or a revert into `main`; it deploys forward through
the same checks. Never deploy code older than the browser data it will meet:
version 1.1 cannot open the browser database that 1.2 created. Re-running CI
rebuilds the same commit, so never re-run an older release job to roll back.

Verify build identity and asset hashes against a downloaded CI artifact with:

```bash
npm run verify:deploy -- --url https://agi.monotio.com --commit COMMIT_SHA --artifact ARTIFACT_DIR
```

Optional `--attempts` and `--delay` control retry count and delay. Then verify
browser behavior with:

```bash
AGI_DEPLOY_URL=https://agi.monotio.com npm --prefix app run e2e:production
```

A deployed site omits the build's chunk graph, so this run skips the lazy-loading
check; the local production run and `npm run check:bundle` cover that build.

Credentials, deployment identity and gateway configuration live outside this
repository.
