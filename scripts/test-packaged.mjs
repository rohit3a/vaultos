import { spawn } from "node:child_process";

import { mkdtempSync, rmSync, realpathSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import net from "node:net";

import assert from "node:assert/strict";

import { chromium } from "playwright";

const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "vaultos-package-test-"));

const listener = net.createServer();

await new Promise(r => listener.listen(0, "127.0.0.1", r));

const port = listener.address().port;

await new Promise(r => listener.close(r));

const executable = path.resolve(process.env.VAULTOS_TEST_APP || "dist/VaultOS Preview-darwin-arm64/VaultOS Preview.app/Contents/MacOS/VaultOS Preview");

const child = spawn(executable, [ `--remote-debugging-port=${port}` ], {
    env: {
        ...process.env,
        VAULTOS_DATA_DIR: path.join(dir, "data")
    },
    stdio: "ignore"
});

let browser;

try {
    let up = false;
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error("Packaged app exited before opening");
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (r.ok) {
                up = true;
                break;
            }
        } catch {}
        await new Promise(r => setTimeout(r, 100));
    }
    assert(up, "Packaged app debugging transport timed out");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    let page;
    for (let i = 0; i < 50; i++) {
        page = context.pages().find(p => p.url().startsWith("vaultos-preview:"));
        if (page) break;
        await new Promise(r => setTimeout(r, 100));
    }
    assert(page);
    await page.getByText("Set up your vault", {
        exact: true
    }).waitFor();
    await page.getByPlaceholder("Master password", {
        exact: true
    }).fill("synthetic-packaged-password");
    await page.getByPlaceholder("Confirm password").fill("synthetic-packaged-password");
    await page.getByRole("button", {
        name: "Create vault",
        exact: true
    }).click();
    await page.getByRole("button", {
        name: "New project"
    }).waitFor();
    const settings = await page.evaluate(() => window.vault.getSettings());
    assert(settings.keyring.secure, "Packaged native Keychain helper missing");
    await page.getByRole("button", {
        name: "Lock",
        exact: true
    }).click();
    await page.getByRole("button", {
        name: "Unlock",
        exact: true
    }).waitFor();
    assert(await page.evaluate(async () => {
        try {
            await window.vault.projects();
            return false;
        } catch {
            return true;
        }
    }));
    console.log("Packaged app passed setup, native-helper discovery and enforced lock using synthetic data.");
} finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise(r => child.once("exit", r));
    }
    rmSync(dir, {
        recursive: true,
        force: true
    });
}
