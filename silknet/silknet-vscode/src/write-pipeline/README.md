# write-pipeline/ — v1.1 SCAFFOLD, DO NOT IMPLEMENT YET

This folder is reserved for the **File Write Pipeline (v1.1)**. It is fully
specified in the Silknet build brief ("FILE WRITE PIPELINE (v1.1 spec — fully
define now, DO NOT implement in this build)"). Nothing here is built in the
v1.0 pass. Any code appearing in this folder before the v1.1 phase begins is a
spec violation.

The `BridgeMessage` union in `src/bridge/message-schema.ts` already reserves
the wire types (`FILE_PROPOSAL`, `FILE_APPROVAL`); nothing sends or acts on
them in v1.0.

## What v1.1 will build here (from the brief — verbatim obligations)

1. **PROPOSE → DIFF → HUMAN APPROVAL → EXACT CACHED BYTES WRITTEN.** The local
   model never writes directly; it always produces a proposal first.
2. Structured, delimiter-based patch format rendered as a diff (`vscode.diff` /
   virtual document provider, or a Webview).
3. **Provenance on every proposal** — which participant generated it, and the
   instruction/context that led to it.
4. **Base-content SHA-256 hash check** at proposal time, re-hashed immediately
   before apply; on mismatch REFUSE and surface
   "File changed since proposal — review required."
5. **Approved diff equals written bytes, always** — the diff is generated and
   cached once; approval writes EXACTLY those cached bytes, never a
   regeneration.
6. **Symlink-aware path safety** — `fs.realpathSync()` on the target AND the
   root, re-verified immediately before the write.
7. **Atomic writes** — secure temp file in a trusted parent directory, fsync,
   atomic rename.
8. **Expanded hard-deny denylist**: `.git/**`, `.env`, `.env.*`, `*.pem`,
   `*.key`, `node_modules/**`, `.vscode/**`, `.idea/**`, `package.json` (or at
   minimum its `"scripts"` block), `Makefile`, `*.lock`, `pyproject.toml`,
   `.cargo/**`.
9. **Positive file-type allowlist** for the standard edit flow; config/build
   manifests get an EXTRA confirmation step.
10. **No execution capability, ever** — no shell/command execution exposed to
    the model under any circumstance.
11. **Separate, explicit gate for destructive operations** (delete, rename,
    chmod) — never bundled into the ordinary modify approval flow.
12. **Unicode BiDi sanitization** — strip/block U+202A–U+202E and U+2066–U+2069
    from any proposed diff BEFORE human review (Trojan Source defense).
13. **A written, explicit threat-model statement** accompanying the pipeline.

A full workspace-wide file picker (choosing files the auto-digest did not
already select) is also deferred to v1.1.
