# Editor setup

Use the local language server to edit LOGIC source in your editor. Install
Node.js 22.22 or newer and run `npm ci` at the repository root, then launch:

```bash
npm run --silent language-server -- --stdio --profile 2.936 --words path/to/WORDS.TOK
```

`--stdio` is required. `--profile` defaults to `2.936`; `--help` lists profile
IDs. `--words` is optional and supplies vocabulary for `said()` completion and
compilation. Restart the server after changing either input. Keep `--silent`
when launching through npm: stdout carries only protocol messages.

Use `.lgc` for LOGIC source files and map that extension to language id
`agi-logic`. This is an editor convention; the compiler accepts source text and
the server selects documents by language id. Positions use UTF-16 and documents
sync in full. The server returns edits for the client to apply.

| Capability     | Scope                                                             |
| -------------- | ----------------------------------------------------------------- |
| Completion     | Commands, operands, local names and the supplied WORDS dictionary |
| Signature help | Command parameters at `(` and `,`                                 |
| Hover          | Command and local symbol documentation                            |
| Definition     | Names declared in the same document                               |
| References     | Uses in the same document                                         |
| Rename         | Prepared, versioned edits in the same document                    |
| Diagnostics    | Compiler and language checks pushed after source changes          |

The browser's LOGIC editor also loads project bindings. The local server reads
only the document and the startup dictionary, so a room, actor or inventory name
supplied by the project needs a local `#define` before it can resolve. Export or
write those definitions in the source you edit. Navigation and rename cover one
document at a time. Syntax colouring requires an editor grammar; the browser's
Monaco tokenizer is separate. Formatting, semantic tokens and code actions are
outside the current server's capabilities.

## Neovim

Add this to `init.lua`, replacing `/path/to/agi` with your checkout:

```lua
vim.filetype.add({ extension = { lgc = 'agi-logic' } })
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'agi-logic',
  callback = function()
    vim.lsp.start({
      name = 'agi-logic',
      cmd = { 'node', '--experimental-strip-types',
        '/path/to/agi/scripts/agi-language-server.ts', '--stdio',
        '--profile', '2.936' },
      root_dir = '/path/to/agi',
    })
  end,
})
```

Add `'--words', '/path/to/game/WORDS.TOK'` to `cmd` for that game's vocabulary.
Use Neovim's LSP mappings for hover, navigation, references and rename.
See the [Neovim LSP documentation](https://neovim.io/doc/user/lsp/).

## Helix

Add to `languages.toml` in your Helix configuration directory:

```toml
[language-server.agi-logic]
command = "node"
args = ["--experimental-strip-types", "/path/to/agi/scripts/agi-language-server.ts", "--stdio", "--profile", "2.936"]

[[language]]
name = "agi-logic"
scope = "source.agi-logic"
language-id = "agi-logic"
file-types = ["lgc"]
roots = ["package.json"]
comment-tokens = "//"
language-servers = ["agi-logic"]
```

Append `"--words", "/path/to/game/WORDS.TOK"` to `args` when needed. Open a
`.lgc` file and use the editor's LSP commands. See the
[Helix language configuration reference](https://docs.helix-editor.com/languages.html).

## VS Code

VS Code needs an extension to launch an arbitrary language server and register
`agi-logic`. A generic LSP client extension works: configure the Node command
and arguments above, register `.lgc` as `agi-logic`, and use stdio. The repository
ships the server and browser tokenizer; an editor extension supplies the file
association and any syntax grammar. Zed likewise needs an extension and grammar.

The [LOGIC reference](logic-language.md) describes accepted source. The wire
checks in [test/logic-lsp.test.ts](../test/logic-lsp.test.ts) exercise the actual
CLI; verify editor configuration in your installed client.
