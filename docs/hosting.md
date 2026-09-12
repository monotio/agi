# Hosting

Run `npm run build` and serve `app/dist` over HTTPS. No special response
headers are required: the app uses no shared memory or isolation-gated
features, so any static host works.

For a subpath such as `/agi/`, build with:

```bash
npm --prefix app run build -- --base=/agi/
```

Check worker loading, ZIP import and provider connections on the actual host.
Production calls providers directly; the development server proxies those
requests locally.

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

Only the owner may merge into protected `main`; the required CI checks apply to
administrators too. A successful push to `main` builds the production artifact,
checks it in separate Chromium and WebKit jobs (`npm --prefix app run
e2e:production`) and deploys from that same CI run. Pull request jobs have no
deployment access, and outside contributors' workflows require approval.
Fixture games are never deployment inputs. Browser failures retain traces for
diagnosis.

Rollback is a revert PR through the same checks; re-running CI rebuilds the
same commit, so never re-run an older release job to roll back.

Verify a deployment with:

```bash
AGI_DEPLOY_URL=https://agi.monotio.com npm --prefix app run e2e:production
```

Credentials, deployment identity and gateway configuration live outside this
repository.
