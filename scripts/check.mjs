import { readdirSync, readFileSync, existsSync } from "node:fs";

import path from "node:path";

import { execFileSync } from "node:child_process";

const excluded = new Set([ ".git", "node_modules", "dist", "out", "native" ]);

function walk(dir) {
    return readdirSync(dir, {
        withFileTypes: true
    }).flatMap(e => excluded.has(e.name) ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [ path.join(dir, e.name) ]);
}

const files = walk(".");

for (const file of files.filter(f => /\.(js|cjs|mjs)$/.test(f))) execFileSync(process.execPath, [ "--check", file ], {
    stdio: "pipe"
});

for (const required of [ "LICENSE", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "renderer/fonts/licenses/Inter-OFL.txt", "renderer/fonts/licenses/SpaceGrotesk-OFL.txt" ]) if (!existsSync(required)) throw new Error("Missing distribution notice: " + required);

const p = JSON.parse(readFileSync("package.json")), lock = JSON.parse(readFileSync("package-lock.json"));

if (p.version !== lock.packages[""].version) throw new Error("Lockfile version differs");

console.log("Source syntax, dependency version and distribution notices checked.");
