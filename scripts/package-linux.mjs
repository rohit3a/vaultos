import { cpSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { execFileSync } from "node:child_process";

import { createHash } from "node:crypto";

import { packager } from "@electron/packager";

import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";

import { APP_FILES } from "./app-files.mjs";

// The Linux build has no native helper, so it can be assembled on Linux or cross-built on macOS.
// A cross-build is not a runtime test; launch it on the target distribution before relying on it.
const arch = process.env.VAULTOS_ARCH || process.arch;

if (![ "arm64", "x64" ].includes(arch)) throw new Error("Supported architectures: arm64, x64");

const pkg = JSON.parse(readFileSync("package.json"));

const executable = "vaultos-preview";

const stage = mkdtempSync(path.join(tmpdir(), "vaultos-package-"));

try {
    for (const file of APP_FILES) {
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
    const [built] = await packager({
        dir: stage,
        name: "VaultOS Preview",
        executableName: executable,
        platform: "linux",
        arch: arch,
        electronVersion: pkg.devDependencies.electron,
        out: "dist",
        overwrite: true,
        asar: true,
        prune: false,
        appVersion: pkg.version,
        buildVersion: "1"
    });
    const folder = path.resolve("dist", `${executable}-linux-${arch}`);
    rmSync(folder, {
        recursive: true,
        force: true
    });
    renameSync(built, folder);
    cpSync("build/icon_1024.png", path.join(folder, `${executable}.png`));
    // Embedded ASAR integrity validation is implemented by Electron only on macOS and Windows,
    // so that fuse is left off here rather than claiming a protection Linux does not enforce.
    await flipFuses(path.join(folder, executable), {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
        [FuseV1Options.OnlyLoadAppFromAsar]: true
    });
    const archive = path.resolve("dist", `VaultOS-${pkg.version}-linux-${arch}-unsigned.tar.gz`);
    execFileSync("tar", [ "-czf", archive, "-C", path.dirname(folder), path.basename(folder) ], {
        stdio: "inherit",
        env: {
            ...process.env,
            COPYFILE_DISABLE: "1"
        }
    });
    writeFileSync(archive + ".sha256", createHash("sha256").update(readFileSync(archive)).digest("hex") + "  " + path.basename(archive) + "\n");
    const sbom = execFileSync("npm", [ "sbom", "--package-lock-only", "--sbom-format=cyclonedx", "--omit=dev" ], {
        cwd: stage,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    writeFileSync(archive.replace(/\.tar\.gz$/, ".cdx.json"), sbom);
    console.log("Built " + archive);
} finally {
    rmSync(stage, {
        recursive: true,
        force: true
    });
}
