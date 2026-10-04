# LOGIC editors

The AGI LOGIC language server gives local editors the same compiler and code
intelligence as the browser LOGIC editor. It uses stdio, UTF-16 positions, the
`.lgc` extension and language id `agi-logic`.

## Install

Use Node 22.22 or newer. From a clone of this repository:

```sh
npm ci
npx --no-install agi-language-server --help
npx --no-install agi-language-server --stdio
```

`--help` writes to stderr. Stdout carries protocol messages. An editor can launch
Node directly, which avoids npm startup and works from any working directory:

```sh
node --experimental-strip-types /path/to/agi/scripts/agi-language-server.ts --stdio
```

Use absolute paths in editor configurations. The executable reports the version
from the clone's `package.json`. The clone includes the server; 1.2 has no dedicated
AGI editor marketplace extension.

## Project files

Pass the app's downloaded project ZIP or an AGI v2/v3 game directory:

```sh
npx --no-install agi-language-server --stdio --project /path/to/game.zip
npx --no-install agi-language-server --stdio --project /path/to/game
```

The loader uses the app's archive validation and interpreter-profile detection.
It reads authored sources, shared project names, WORDS and OBJECT. Native LOGIC
resources provide disassembled sources where authored source is unavailable.
Room, VIEW and SOUND names use the same bindings as the browser. Local `#define`
names and labels keep their document scope. The compiler's existing directives
are `#define` and `#message`; shared names come from `bindings.json`.

Extract an editor folder from a project into a **new directory**:

```sh
npx --no-install agi-language-server --project /path/to/game.zip --extract-sources /path/to/sources
npx --no-install agi-language-server --stdio --project /path/to/game.zip --sources /path/to/sources
```

The command refuses an existing destination. It writes:

```text
sources/
  logic.0.lgc
  logic.1.lgc
  bindings.json
  WORDS.TOK
  OBJECT
```

`logic.<number>.lgc`, with numbers 0 through 255 and no leading zeroes, maps to the
app's LOGIC resource number. This keeps the resource IDs already stored in an
export. A separate header is unnecessary. Files in `--sources` override archived
sources and inputs. Without that option, the source folder is the game directory
or the ZIP's parent directory. Every project LOGIC participates in references and
rename, including closed files. Extract sources first to give an external editor
real files for navigation and edits; archived sources alone have virtual URIs.

`bindings.json` uses the project's existing representation:

```json
{
  "door_open": { "kind": "flag", "num": 40 },
  "hall": { "kind": "room", "num": 1 }
}
```

WORDS and inventory names supply completions; OBJECT completions insert native
`o<number>` operands. Extracted WORDS and OBJECT are language-context copies.
Source extraction and LSP edits update editor files. Building a playable project
still uses the app's validated project compiler and export workflow.

Clients supporting dynamic file watchers receive a registration for project
inputs. Other clients can send `workspace/didChangeWatchedFiles` after changing
the archive, resource files, `.lgc` files, `bindings.json`, WORDS.TOK or OBJECT.
Reloading inputs also republishes open-document diagnostics. An invalid reload
keeps the previous valid project and reports the cause in the client log.

Without `--project`, open documents use the standalone profile `2.936` and local
definitions. Optional `--profile ID` and `--words /path/to/WORDS.TOK` select the
standalone context. `--help` lists the supported profiles.

## Capabilities

| Feature                   | Behavior                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------- |
| Diagnostics               | Compiler errors and warnings; push and pull, incremental document sync              |
| Completion                | Commands, registers, local and shared names, WORDS and OBJECT                       |
| Hover and signature help  | Shared command documentation and operand information                                |
| Definition and references | Names and numbered operands across LOGIC sources; messages stay within their LOGIC  |
| Rename                    | Local names or coordinated project binding and source edits; byte-preserving checks |
| Symbols                   | Document labels, defines, messages and `said()` blocks; workspace search            |
| Highlight                 | Occurrences of the selected name or numbered operand in the document                |
| Semantic tokens           | Full and range colouring from the compiler lexer                                    |
| Folding                   | Multiline brace blocks                                                              |
| Quick fixes               | Define an unknown name as `0`; add a missing semicolon when analysis confirms it    |
| Message hints and actions | Show text beside `print(mN)`; move text to `#message` or put it inline              |
| Cancellation              | Standard `$/cancelRequest`; stale browser replies lose authority                    |

Review the value introduced by a define quick fix before compiling. Rename
returns proposed versioned edits for the client to apply. Project renames also
edit `bindings.json` and reject conflicting names or changes to compiled bytes.
The browser applies coordinated renames through project History, so Undo restores
the affected documents together. In the app, a resource name opens its editor. A flag or variable opens a list of
LOGIC lines where it is set and checked. Hover offers Open and Rename, and the
parts list includes Game state. External editors navigate to `bindings.json`.
Closed-file references open in read-only source previews. Formatting is omitted: the project has no
canonical LOGIC formatter, and preserving authored message text matters.

Numbered operands identify variables (`vN`), flags (`fN`), screen objects (`oN`),
inventory items (`iN`), strings (`sN`), words (`wN`) and controllers (`cN`) across
the game. Names used for the same kind and number share those references.
Messages (`mN`) include their `#message N` declaration within the current LOGIC.
Argument types distinguish numbered symbols from literal values. Hover shows
the operand kind, number, bound names and use count. Definition opens a message
declaration or a project binding. Rename applies to names; numbered identities
stay fixed.

## Neovim

For Neovim 0.11 or newer, add this to `init.lua`. Replace the paths:

This recipe was tested headless with Neovim 0.12.5 against a v2 game directory,
with sources extracted using `--extract-sources`.

```lua
vim.filetype.add({ extension = { lgc = 'agi-logic' } })
vim.lsp.config('agi_logic', {
  cmd = {
    'node', '--experimental-strip-types',
    '/path/to/agi/scripts/agi-language-server.ts', '--stdio',
    '--project', '/path/to/game', '--sources', '/path/to/sources',
  },
  filetypes = { 'agi-logic' },
  root_markers = { 'bindings.json' },
  workspace_required = false,
})
vim.lsp.enable('agi_logic')
```

Check it works with the cursor on an operand such as `v0`:

```vim
:checkhealth vim.lsp
:lua vim.lsp.buf.references()
```

The configuration follows
[Neovim's LSP setup API](https://neovim.io/doc/user/lsp.html).

## Helix

Untested in Helix.

Put this in your project's `.helix/languages.toml`:

```toml
[[language]]
name = "agi-logic"
language-id = "agi-logic"
scope = "source.agi-logic"
file-types = ["lgc"]
roots = ["bindings.json"]
comment-tokens = ["//"]
indent = { tab-width = 2, unit = "  " }
language-servers = ["agi-logic"]

[language-server.agi-logic]
command = "node"
args = ["--experimental-strip-types", "/path/to/agi/scripts/agi-language-server.ts", "--stdio", "--project", "/path/to/game.zip", "--sources", "/path/to/sources"]
```

Run `hx --health agi-logic` to check the command. Helix's available LSP features
depend on its version; this repository ships semantic tokens rather than a
Tree-sitter grammar. See the [Helix language configuration](https://docs.helix-editor.com/languages.html).

## Zed

Untested in Zed.

Zed registers new language servers through extensions. For an AGI-only project,
a local configuration can use its existing C server slot. Put this in
`.zed/settings.json` and replace the paths:

```json
{
  "file_types": { "C": ["lgc"] },
  "languages": {
    "C": {
      "language_servers": ["clangd"],
      "format_on_save": "off",
      "semantic_tokens": "full"
    }
  },
  "lsp": {
    "clangd": {
      "binary": {
        "path": "/path/to/node",
        "arguments": [
          "--experimental-strip-types",
          "/path/to/agi/scripts/agi-language-server.ts",
          "--stdio",
          "--project",
          "/path/to/game.zip",
          "--sources",
          "/path/to/sources"
        ]
      }
    }
  }
}
```

This replaces the C server for that workspace. The AGI server recognizes `.lgc`
URIs even when a generic client sends another language id. Use a separate AGI
workspace when editing C files too. See [Zed language settings](https://zed.dev/docs/configuring-languages)
and [language extensions](https://zed.dev/docs/extensions/languages).

## VS Code

Untested in VS Code.

Install a generic stdio LSP client, such as
[Generic LSP Client (`llllvvuu.llllvvuu-glspc`)](https://github.com/llllvvuu/vscode-glspc).
For that extension, use `.vscode/settings.json`:

```json
{
  "files.associations": { "*.lgc": "plaintext" },
  "glspc.languageId": "plaintext",
  "glspc.serverCommand": "node",
  "glspc.serverCommandArguments": [
    "--experimental-strip-types",
    "/path/to/agi/scripts/agi-language-server.ts",
    "--stdio",
    "--project",
    "/path/to/game.zip",
    "--sources",
    "/path/to/sources"
  ]
}
```

The generic client's host language is plain text; `.lgc` recognition still
attaches AGI analysis. Consult that extension's settings when using another
generic client.

## Troubleshooting

| Symptom                                  | Next step                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Server exits immediately                 | Run the same command with `--help`; check Node and absolute paths.                      |
| Project names are unknown                | Check `--project`, `--sources` and the client's server log for input validation errors. |
| `said()` reports unknown words           | Check the project's WORDS.TOK or standalone `--words` input.                            |
| Closed-file navigation cannot open a URI | Extract sources and use `--sources`; confirm the `logic.<number>.lgc` names.            |
| Input changes stay stale                 | Check dynamic watcher support or send `workspace/didChangeWatchedFiles`.                |
| Rename is refused                        | Fix source errors, choose an unused identifier and review the referenced binding.       |
| Colouring stays plain                    | Check the client's semantic-token support and theme settings.                           |

The automated suite launches the real CLI with the official LSP protocol client,
compares its answers with the browser worker, and checks tutorial compilation
against the app and shipped bytes. Browser tests exercise rename, outline,
folding, colouring, numbered-operand references and quick fixes. The Neovim
recipe was tested headless with Neovim 0.12.5 against a v2 game directory.
The Helix, Zed and VS Code configurations remain untested in their target editors.
