# Third-party components

`internal/backend` incorporates the existing fish-hand production-candidate maintenance implementation as of 2026-11-13, adapted for package-relative imports and per-Profile configuration. It is maintained here with fish-body under the repository MIT license; it does not contain upstream source material downloaded for individual plugin requests or private runtime records.

Normal pinned npm dependencies: `yaml@2.8.1`, `pnpm@12.4.2`, `npm@11.6.2`. Original licenses and notices, including those of their transitive dependencies, are retained in their installed packages. Authorized lifecycle execution uses npm's bundled @npmcli/run-script; there is no copied hidden system npm module.

SHA-256 uses Node's built-in crypto; no additional SHA implementation is distributed.
