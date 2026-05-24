# Change Log

All notable changes to the `dial-chat-model-provider` extension will be documented in this file. See [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0] — 2026-05-24

Initial public release.

### Features

- **VS Code Language Model Chat Provider** (`vendor: dial`). Once authenticated, DIAL deployments appear in the Copilot model picker and any other client of `vscode.lm.*`.
- **OpenID Connect sign-in** (Authorization Code + PKCE per RFC 7636, S256, 16-byte random `state`, system browser per RFC 8252, loopback callback at `http://127.0.0.1:PORT/oauth-callback`).
- **Automatic OIDC client registration** via Keycloak Dynamic Client Registration — anonymous when the realm allows it, or authenticated with an admin-issued initial access token. The negotiated `client_id` is written to settings; the `client_secret` (for confidential clients) goes to the OS keychain.
- **Manual OIDC client** — paste a pre-registered `client_id` (and optional `client_secret`) into the keychain instead of DCR.
- **API-key authentication** as an alternative to OIDC for environments where users get a long-lived key instead of an OIDC account.
- **Streaming chat completions** over SSE (`stream=true`), text and `tool_calls` deltas mapped to `LanguageModelTextPart` / `LanguageModelToolCallPart`.
- **Tool / function calling** with auto / required tool modes.
- **Deployment-aware parameters.** The extension reads `features` from DIAL's deployment listing and tailors each request: `max_tokens_supported` / `max_completion_tokens_supported` choose the output-limit field (GPT-5 / o-series get `max_completion_tokens`, classic models get `max_tokens`), `custom_temperature_supported: false` omits `temperature`, `tools_supported`, attachment flags, and more.
- **Resilient retry** when the upstream model contradicts DIAL's flags. Bidirectional swap between `max_tokens` ↔ `max_completion_tokens` (each direction tried at most once, then field is dropped) and one-shot drop of `temperature`. Capped at 4 attempts, cannot oscillate.
- **`CancellationToken` propagation.** Cancelling the Copilot turn tears down the in-flight axios request and the SSE stream.
- **DIAL: Open Settings**, **DIAL: Login**, **DIAL: Logout**, **DIAL: Clear OAuth Client**, **DIAL: Set API Key**, **DIAL: Set OIDC Client Secret**, **DIAL: Set OIDC Initial Access Token** — all command-palette driven.

### Security model

- **All secrets in the OS keychain** (`vscode.SecretStorage` — Windows Credential Manager / macOS Keychain / libsecret). Settings hold only public identifiers (server URL, scopes, callback port, OIDC `client_id`, browser profile). A single `DialSecrets` facade is the only module that touches `context.secrets`.
- **HTTPS enforcement.** Activation warns when `dial.serverUrl` is non-loopback `http://` — JWT and API-KEY would otherwise travel in clear text.
- **Multi-byte-safe SSE.** `string_decoder.StringDecoder` preserves UTF-8 sequences split across chunks.
- **Refresh-token rotation** is honored; `invalid_grant` / `session not active` / `refresh token expired` clears the session.
- **Sanitised logs.** The DIAL output channel never contains access / refresh tokens, the authorization code, the PKCE verifier, the `state`, the client secret, or the API key. It records only opaque identifiers (`sub`, `azp`, `client_id`, `tool_call_id`), JWT claim metadata (`aud`, `scope`, `exp`, roles), and message character counts. SSE upstream errors are reduced to `message` / `code` / `type` so error payloads cannot echo request bodies into logs.
- **Process safety.** Browser detection in `oauthBrowserProcess.ts` uses `execFileSync` (no shell).

### Quality & dependencies

- **Single runtime dependency: `axios ^1.16.1`** (latest at release time; covers 15 high-severity CVEs that affected the previous line).
- **`npm audit` reports 0 vulnerabilities** thanks to explicit `overrides` for transitive dev packages (`diff`, `serialize-javascript`, `brace-expansion`, `flatted`, `fast-uri`, `follow-redirects`, `picomatch`).
- **22 unit tests** covering JWT expiry logic and the deployment / chat-request builder pipeline (partial feature-flag payloads, garbage flag types, retry helpers, request serialization).
- **Strict TypeScript** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`) plus ESLint rules that ban `any`, non-null assertions, and parameter reassignment.

### Build & packaging

- **Production bundle** via `webpack --mode production --no-devtool`: minified, no sourcemaps, no debug info shipped.
- **VSIX includes only what end users need:** `README.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, `package.json`, `dial-logo.png`, `dist/extension.js`. Source code, sourcemaps, configs, governance files (`ARCHITECTURE.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`), `.git`, and `.gitattributes` are excluded.
- **Cross-platform line endings.** `.gitattributes` normalises all text files to LF and marks binary asset extensions as binary, so Windows / macOS / Linux checkouts stay consistent.

### Legal

- **License: Apache-2.0** (`LICENSE`).
- **Trademark attribution** for **AI DIAL / AI DIAL Core** (intellectual property of EPAM Systems, Inc.) lives in `NOTICE` and the README. This extension is an independent integration and is not affiliated with, sponsored by, or endorsed by EPAM Systems, Inc.
- `CODE_OF_CONDUCT.md` and `SECURITY.md` define community and vulnerability-reporting policies (kept in the repo, not shipped in the VSIX).
