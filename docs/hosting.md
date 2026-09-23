# Hosting

AGI IS HERE is a static web app with no server of its own: players' browsers
talk to their AI provider directly. Any static host that serves HTTPS can run a
copy.

## Building and serving

Run `npm run build` and serve `app/dist` over HTTPS. No special response headers
are required: the app uses no shared memory or isolation-gated features.

For a subpath such as `/agi/`, build with:

```bash
npm --prefix app run build -- --base=/agi/
```

Check worker loading, ZIP import and provider connections on the actual host.
Production calls providers directly; only the development server proxies those
requests locally.

## Including games on your site

The bundled tutorial needs no setup. To offer additional games you have
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

## Production releases

The public site at [agi.monotio.com](https://agi.monotio.com/) deploys from
`main`.

- Only the owner may merge into protected `main`, and the required CI checks
  apply to administrators too.
- A successful push to `main` builds the production artifact, checks it in
  separate Chromium and WebKit jobs (`npm --prefix app run e2e:production`) and
  deploys from that same CI run.
- Pull request jobs have no deployment access, and workflows from outside
  contributors require approval.
- Fixture games are never deployment inputs. Browser failures keep their traces
  for diagnosis.

To roll back, open a revert pull request and let it pass the same checks.
Re-running CI rebuilds the same commit, so never re-run an older release job to
roll back.

Verify a deployment with:

```bash
AGI_DEPLOY_URL=https://agi.monotio.com npm --prefix app run e2e:production
```

Credentials, deployment identity and gateway configuration live outside this
repository.
