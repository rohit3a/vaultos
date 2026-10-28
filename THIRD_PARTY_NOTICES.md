# Third-party notices

VaultOS source and its original artwork are MIT licensed. Provider names identify supported credential categories; they do not imply endorsement. Third-party provider logo artwork is not bundled.

- **Electron / Chromium / Node.js**: retain the runtime's accompanying `Contents/Resources/LICENSE.electron` and `Contents/Resources/LICENSES.chromium.html` in packaged distributions. Electron uses MIT and includes components with their respective licenses.
- **PDFKit**, **dotenv**, and **Model Context Protocol TypeScript SDK**: MIT licensed. Production dependencies and transitive packages retain their license files under the packaged `node_modules`; exact versions and integrity hashes are in `package-lock.json`.

The release includes an npm CycloneDX dependency inventory. This is an inventory, not a vulnerability-free certification. Development/build tools retain their own licenses in their installed packages and are excluded from the application's production dependency tree. age and Git are optional external executables installed separately by the user.
