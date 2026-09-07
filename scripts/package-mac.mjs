import { cpSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { execFileSync } from "node:child_process";

import { createHash } from "node:crypto";

import { packager } from "@electron/packager";

import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";

if (process.platform !== "darwin") throw new Error("Build macOS artifacts on macOS");

const arch = process.env.VAULTOS_ARCH || process.arch;

if (![ "arm64", "x64" ].includes(arch)) throw new Error("Supported architectures: arm64, x64");

const pkg = JSON.parse(readFileSync("package.json"));

const stage = mkdtempSync(path.join(tmpdir(), "vaultos-package-"));

const files = [ "main.js", "preload.js", "store.js", "agents.js", "api.js", "crypto.js", "env-file.js", "fs-safe.js", "validation.js", "paths.js", "model.js", "providers.js", "version.js", "keyring.js", "session.js", "backend.cjs", "sync.js", "git.js", "export.js", "renderer", "mcp", "cli.cjs", "prompt.js", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "build/icon_1024.png", "build/AppIcon.icns" ];

try {
    for (const file of files) {
        mkdirSync(path.dirname(path.join(stage, file)), {
            recursive: true
        });
        cpSync(file, path.join(stage, file), {
            recursive: true
        });
    }
    execFileSync("npm", [ "ci", "--omit=dev", "--ignore-scripts" ], {
        cwd: stage,
        stdio: "inherit"
    });
    execFileSync(process.execPath, [ "scripts/build-native.mjs" ], {
        stdio: "inherit",
        env: {
            ...process.env,
            VAULTOS_ARCH: arch === "x64" ? "x86_64" : arch
        }
    });
    const [folder] = await packager({
        dir: stage,
        name: "VaultOS Preview",
        platform: "darwin",
        arch: arch,
        electronVersion: pkg.devDependencies.electron,
        out: "dist",
        overwrite: true,
        asar: true,
        prune: false,
        appBundleId: "org.vaultos.preview",
        appVersion: pkg.version,
        buildVersion: "1",
        appCategoryType: "public.app-category.developer-tools",
        icon: "build/AppIcon.icns",
        darwinDarkModeSupport: true,
        extendInfo: {
            LSMinimumSystemVersion: "13.0"
        },
        extraResource: [ "build/native/vaultos-keychain" ]
    });
    const bundle = path.join(folder, "VaultOS Preview.app");
    await flipFuses(bundle, {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true
    });
    if (process.env.VAULTOS_SIGN_IDENTITY) {
        const {signAsync: signAsync} = await import("@electron/osx-sign");
        await signAsync({
            app: bundle,
            identity: process.env.VAULTOS_SIGN_IDENTITY,
            hardenedRuntime: true,
            optionsForFile: () => ({
                entitlements: "build/entitlements.plist"
            })
        });
        if (!process.env.VAULTOS_NOTARY_PROFILE) throw new Error("Signed public builds require a notarization profile");
        const {notarize: notarize} = await import("@electron/notarize");
        await notarize({
            appPath: bundle,
            keychainProfile: process.env.VAULTOS_NOTARY_PROFILE
        });
    } else {
        execFileSync("/usr/bin/codesign", [ "--force", "--deep", "--sign", "-", "--identifier", "org.vaultos.preview", bundle ], {
            stdio: "inherit"
        });
    }
    execFileSync("/usr/bin/codesign", [ "--verify", "--deep", "--strict", bundle ], {
        stdio: "inherit"
    });
    const kind = process.env.VAULTOS_SIGN_IDENTITY ? "notarized" : "unsigned";
    const zip = path.resolve("dist", `VaultOS-${pkg.version}-macOS-${arch}-${kind}.zip`);
    execFileSync("/usr/bin/ditto", [ "-c", "-k", "--sequesterRsrc", "--keepParent", bundle, zip ]);
    writeFileSync(zip + ".sha256", createHash("sha256").update(readFileSync(zip)).digest("hex") + "  " + path.basename(zip) + "\n");
    const sbom = execFileSync("npm", [ "sbom", "--package-lock-only", "--sbom-format=cyclonedx", "--omit=dev" ], {
        cwd: stage,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    writeFileSync(zip.replace(/\.zip$/, ".cdx.json"), sbom);
    console.log("Built " + zip);
} finally {
    rmSync(stage, {
        recursive: true,
        force: true
    });
}
