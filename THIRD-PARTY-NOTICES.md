# Third-party components

`internal/backend` incorporates the existing fish-hand production-candidate maintenance implementation as of 2026-11-13, adapted for package-relative imports and per-Profile configuration. It is maintained here with fish-body under the repository MIT license; it does not contain upstream source material downloaded for individual plugin requests or private runtime records.

Normal pinned npm dependencies: `yaml@2.8.1`, `pnpm@12.4.2`, `npm@11.6.2`, `tar@7.5.23` (BlueOak-1.0.0, https://github.com/isaacs/node-tar). Original licenses and notices, including those of their transitive dependencies, are retained in their installed packages. Authorized lifecycle execution uses npm's bundled @npmcli/run-script; there is no copied hidden system npm module.

SHA-256 uses Node's built-in crypto; no additional SHA implementation is distributed.

Explicit, read-only source analysis uses pinned `dependency-cruiser@18.8.0`
(https://github.com/sverweij/dependency-cruiser), `@ast-grep/cli@0.51.3`
(https://github.com/ast-grep/ast-grep), and `ts-morph@28.0.0`
(https://github.com/dsherret/ts-morph), all MIT. Their installed packages retain
their licenses and those of transitive dependencies (including TypeScript).
The ast-grep native binary is resolved from its official optional platform
package; fish-body does not copy analyzer source or binaries into its tarball.
