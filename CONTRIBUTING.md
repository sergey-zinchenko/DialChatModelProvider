# Contributing

## Toolchain

- Node.js 20+
- npm
- VS Code 1.110+ (extension host target)

```bash
npm install
```

Recommended workspace extensions: ESLint, Prettier, EditorConfig (prompted on open).

## Scripts

```bash
npm run compile       # webpack dev build (mode: none, source maps for debugger)
npm run watch         # webpack watch mode
npm run lint          # ESLint
npm run lint:fix      # ESLint with --fix
npm run format        # Prettier (write)
npm run format:check  # Prettier (check only — CI)
npm run check         # format:check + lint + compile
npm run package       # production bundle (Terser minified, no sourcemap)
npm run test          # vscode-test (integration tests)
```

## Building a release VSIX

```bash
npm run package
npx @vscode/vsce package --no-yarn
```

The `.vscodeignore` keeps only the necessary files in the VSIX:
`README.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, `package.json`, `dial-logo.png`, `dist/extension.js`, `dist/extension.js.LICENSE.txt`.

Anything else (source, sourcemaps, configs, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `node_modules`, `.git/**`, `.gitattributes`) is stripped.

`NOTICE` contains the trademark attribution for DIAL / AI DIAL Core (property of EPAM Systems, Inc.) — it must ship inside the VSIX. Do not add it to `.vscodeignore`.

## Continuous integration and releases

Everything is driven by a single workflow `.github/workflows/ci.yml` with two jobs:

- **`build`** runs on every push to `main`, every pull request, and every tag push. Steps: `npm ci`, `npm audit --omit=dev`, `npm run check`, headless VS Code unit tests under `xvfb-run`.
- **`release`** runs **only** on tag pushes matching `v*.*.*` and only after `build` is green. Steps: verify the tag matches `package.json` version, package the VSIX, extract the matching `[X.Y.Z]` section from `CHANGELOG.md` as release notes, create a GitHub Release with the VSIX attached, and (when the optional `VSCE_PAT` / `OVSX_PAT` secrets are present) publish to the VS Code Marketplace and Open VSX Registry respectively.

PRs cannot merge with a red `build`. PR branches cannot push tags from forks, so the `release` job is unreachable from external contributors.

### Cutting a release

To cut version `X.Y.Z`:

1. Bump `version` in `package.json` and add a `## [X.Y.Z] — YYYY-MM-DD` section to `CHANGELOG.md`.
2. Commit the bump (`git commit -am "Release X.Y.Z"`) and push to `main`.
3. Tag and push the tag:

    ```bash
    git tag -a vX.Y.Z -m "Release X.Y.Z"
    git push origin vX.Y.Z
    ```

The CI workflow will fire twice — once for the push to `main` (only `build` runs), and once for the tag push (`build` runs again, then `release` runs after it succeeds). The workflow fails fast if the tag does not match `package.json` version.

### Optional: VS Code Marketplace publishing

If a repository secret named `VSCE_PAT` (Personal Access Token from Azure DevOps with `Marketplace → Manage` scope) is configured, the `release` job additionally runs `vsce publish` after the GitHub Release succeeds. Without the secret the publish step is skipped and only the GitHub Release is produced.

### Optional: Open VSX publishing

The Open VSX Registry ([open-vsx.org](https://open-vsx.org)) is the open-source extension registry used by VSCodium, Cursor, Theia, Gitpod, and other VS Code derivatives that cannot legally consume the Microsoft Marketplace. If a repository secret named `OVSX_PAT` is configured, the `release` job additionally runs `ovsx publish` against the same VSIX after the GitHub Release succeeds. Without the secret the publish step is skipped.

One-time setup (done outside CI, by a human with publish rights):

1. Create an Eclipse Foundation account and sign the Open VSX Publisher Agreement at [open-vsx.org](https://open-vsx.org) — see the [official guide](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions).
2. Generate an access token from your Open VSX profile (`Settings → Access Tokens → Generate New Token`).
3. Create the namespace once with `npx ovsx create-namespace <publisher> -p <token>`, where `<publisher>` matches the `publisher` field in `package.json` (currently `sergey-zinchenko`). The chosen name **must match your GitHub username** so that Open VSX grants you verified ownership automatically — see [Namespace Access](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access). Mismatched namespaces can still publish, but show up as _unverified_.
4. Store the token as a GitHub Actions repository secret named `OVSX_PAT`.

Subsequent releases are fully automated — pushing a `vX.Y.Z` tag triggers `ovsx publish` with the just-built VSIX.

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the module overview, request flow, deployment feature flags, and the auth/secrets storage model.

## Logging

Output channel **DIAL** (`vscode.LogOutputChannel`). Levels: `info`, `warn`, `error`.
Sensitive values must **never** reach the log — see `logSanitize.ts`, `jwtUtils.summarizeAccessToken`, and the redaction in `chatRequestBuilder.sanitizeApiBodyForLog`.

## Coding standards

- Strict TypeScript (`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, etc.).
- ESLint rules ban `any`, non-null assertions, `var`, parameter reassignment, throwing literals.
- `Nullable<T> = T | undefined`. Prefer `undefined`; `null` survives only where required by the OpenAI wire format (`assistant.content` with `tool_calls`).
- All `SecretStorage` access goes through the `DialSecrets` facade — nothing else touches `context.secrets` directly.
