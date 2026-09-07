import { _electron as electron } from "playwright";

import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import assert from "node:assert/strict";

const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "vaultos-ui-test-"));

const app = await electron.launch({
    args: [ "." ],
    env: {
        ...process.env,
        VAULTOS_DATA_DIR: path.join(dir, "data")
    }
});

try {
    const page = await app.firstWindow();
    await page.waitForSelector("text=Set up your vault");
    const denied = await page.evaluate(async () => {
        try {
            await window.vault.projects();
            return false;
        } catch {
            return true;
        }
    });
    assert(denied, "IPC must be locked before setup");
    await page.getByPlaceholder("Master password", {
        exact: true
    }).fill("synthetic-ui-password");
    await page.getByPlaceholder("Confirm password").fill("synthetic-ui-password");
    await page.getByRole("button", {
        name: "Create vault",
        exact: true
    }).click();
    await page.getByRole("button", {
        name: "New project"
    }).click();
    await page.getByPlaceholder("Project name").fill("Example App");
    await page.getByRole("button", {
        name: "Add",
        exact: true
    }).click();
    await page.waitForSelector("text=Add key");
    await page.evaluate(async () => {
        await window.vault.setSecret("Example App", {
            key: "DEMO_API_KEY",
            value: "synthetic-demo-only",
            provider: "custom",
            note: "Synthetic example. Never a live credential."
        });
    });
    await page.getByRole("button", {
        name: "Projects",
        exact: false
    }).first().click();
    await page.getByRole("button", {
        name: "Example App",
        exact: false
    }).click();
    await page.getByRole("button", {
        name: "Reveal",
        exact: true
    }).click();
    assert(await page.getByText("Value: synthetic-demo-only").isVisible());
    mkdirSync("docs/images", {
        recursive: true
    });
    await page.screenshot({
        path: "docs/images/vaultos-preview.png"
    });
    await page.getByRole("button", {
        name: "Lock",
        exact: true
    }).click();
    await page.getByRole("button", {
        name: "Unlock",
        exact: true
    }).waitFor();
    assert(!await page.getByText("Value: synthetic-demo-only").count());
    const locked = await page.evaluate(async () => {
        try {
            await window.vault.reveal("Example App", "DEMO_API_KEY");
            return false;
        } catch {
            return true;
        }
    });
    assert(locked, "Lock must revoke IPC access");
    await page.getByPlaceholder("Master password", {
        exact: true
    }).fill("synthetic-ui-password");
    await page.getByRole("button", {
        name: "Unlock",
        exact: true
    }).click();
    await page.getByRole("button", {
        name: "Example App",
        exact: false
    }).waitFor();
    const attempted = await page.evaluate(() => window.open("https://example.com"));
    assert.equal(attempted, null);
    assert.equal((await app.windows()).length, 1);
    console.log("Desktop flow passed: setup, locked IPC, create, reveal, lock, unlock, blocked popups. Synthetic screenshot saved.");
} finally {
    await app.close();
    rmSync(dir, {
        recursive: true,
        force: true
    });
}
