"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), net = require("node:net");

const {Keyring: Keyring} = require("../keyring"), {Store: Store} = require("../store"), {defaultDataDir: defaultDataDir} = require("../paths");

const PW = "synthetic-linux-keyring-password";

// A stand-in for libsecret's secret-tool. It keeps one item per attribute set in a temp directory
// and records its arguments so tests can prove the password never appears in argv.
const FAKE_SECRET_TOOL = `#!/bin/sh
[ -n "$FAKE_SECRET_FAIL" ] && { echo "secret-tool: Cannot create an item in a locked collection" >&2; exit 1; }
printf '%s\\n' "$*" >> "$FAKE_SECRET_STORE/argv.log"
printf '%s' "$DBUS_SESSION_BUS_ADDRESS" > "$FAKE_SECRET_STORE/bus"
cmd=$1; shift
[ "$cmd" = store ] && shift
item="$FAKE_SECRET_STORE/item-$(printf '%s' "$*" | tr -c 'A-Za-z0-9.' '_')"
case "$cmd" in
  store) cat > "$item" ;;
  lookup) [ -f "$item" ] || exit 1; cat "$item" ;;
  clear) rm -f "$item" ;;
  *) exit 2 ;;
esac
`;

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-platform-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    const bin = path.join(dir, "bin"), secrets = path.join(dir, "secrets"), empty = path.join(dir, "empty");
    for (const d of [ bin, secrets, empty ]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(bin, "secret-tool"), FAKE_SECRET_TOOL, {
        mode: 448
    });
    const env = {
        PATH: [ bin, "/usr/bin", "/bin" ].join(path.delimiter),
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/bus",
        FAKE_SECRET_STORE: secrets
    };
    return {
        dir: dir,
        bin: bin,
        secrets: secrets,
        empty: empty,
        env: env
    };
}

const skip = process.platform === "win32";

test("Linux keyring stores, reads and clears through secret-tool without argv secrets", {
    skip: skip
}, t => {
    const {dir: dir, secrets: secrets, env: env} = fixture(t);
    const keyring = new Keyring(path.join(dir, "data"), {
        platform: "linux",
        env: env
    });
    assert.match(keyring.service, /^org\.vaultos\.preview\.[a-f0-9]{24}$/);
    assert.deepEqual(keyring.describe().store, "libsecret");
    assert.equal(keyring.describe().secure, true);
    assert.equal(keyring.get(), null);
    assert.equal(keyring.set(PW).store, "libsecret");
    assert.equal(keyring.get(), PW);
    const argv = fs.readFileSync(path.join(secrets, "argv.log"), "utf8");
    assert(!argv.includes(PW));
    assert(argv.includes(`lookup service ${keyring.service} account master-password`));
    assert(argv.includes(`store --label=VaultOS Preview master password service ${keyring.service} account master-password`));
    const other = new Keyring(path.join(dir, "other"), {
        platform: "linux",
        env: env
    });
    assert.notEqual(other.service, keyring.service);
    assert.equal(other.get(), null);
    keyring.clear();
    assert.equal(keyring.get(), null);
    assert.doesNotThrow(() => keyring.clear());
});

test("Linux keyring is unavailable without secret-tool and never writes a plaintext fallback", {
    skip: skip
}, t => {
    const {dir: dir, empty: empty} = fixture(t);
    const data = path.join(dir, "data");
    fs.mkdirSync(data);
    const keyring = new Keyring(data, {
        platform: "linux",
        env: {
            PATH: [ "relative-bin", empty ].join(path.delimiter),
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/bus"
        }
    });
    assert.equal(keyring.describe().store, "unavailable");
    assert.equal(keyring.describe().secure, false);
    assert.match(keyring.describe().detail, /secret-tool/);
    assert.equal(keyring.get(), null);
    assert.throws(() => keyring.set(PW), /secret-tool/);
    assert.doesNotThrow(() => keyring.clear());
    assert.deepEqual(fs.readdirSync(data), []);
});

test("Linux keyring ignores relative PATH entries", {
    skip: skip
}, t => {
    const {dir: dir, bin: bin, env: env} = fixture(t);
    const keyring = new Keyring(path.join(dir, "data"), {
        platform: "linux",
        env: {
            ...env,
            PATH: path.relative(process.cwd(), bin)
        }
    });
    assert.equal(keyring.describe().secure, false);
});

test("Linux keyring finds the user session bus when DBUS_SESSION_BUS_ADDRESS is missing", {
    skip: skip
}, async t => {
    const {dir: dir, secrets: secrets, env: env} = fixture(t);
    const runtime = path.join(dir, "run");
    fs.mkdirSync(runtime, {
        mode: 448
    });
    const base = {
        PATH: env.PATH,
        FAKE_SECRET_STORE: secrets,
        XDG_RUNTIME_DIR: runtime
    };
    const missing = new Keyring(path.join(dir, "data"), {
        platform: "linux",
        env: base
    });
    assert.equal(missing.describe().secure, false);
    assert.match(missing.describe().detail, /D-Bus/);
    assert.throws(() => missing.set(PW), /D-Bus/);
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once("error", reject).listen(path.join(runtime, "bus"), resolve));
    t.after(() => server.close());
    const found = new Keyring(path.join(dir, "data"), {
        platform: "linux",
        env: base
    });
    assert.equal(found.describe().secure, true);
    found.set(PW);
    assert.equal(fs.readFileSync(path.join(secrets, "bus"), "utf8"), `unix:path=${path.join(runtime, "bus")}`);
});

test("Linux Secret Service failures are reported and not mistaken for a stored password", {
    skip: skip
}, t => {
    const {dir: dir, env: env} = fixture(t);
    const data = path.join(dir, "data");
    fs.mkdirSync(data);
    const keyring = new Keyring(data, {
        platform: "linux",
        env: {
            ...env,
            FAKE_SECRET_FAIL: "1"
        }
    });
    assert.equal(keyring.get(), null);
    assert.throws(() => keyring.set(PW), /Secret Service operation failed/);
    assert.throws(() => keyring.clear(), /Secret Service operation failed/);
    assert.deepEqual(fs.readdirSync(data), []);
});

test("remembered background unlock works through the Linux keyring only after opt-in", {
    skip: skip
}, t => {
    const {dir: dir, env: env} = fixture(t);
    const store = new Store(path.join(dir, "data"));
    store.keyring = new Keyring(store.dataDir, {
        platform: "linux",
        env: env
    });
    store.init(PW);
    assert.equal(store.keyring.get(), null);
    store.lock();
    assert.equal(store.autoUnlock(), false);
    store.unlock(PW);
    store.setSettings({
        rememberPassword: true
    });
    assert.equal(store.getSettings().keyring.store, "libsecret");
    store.lock();
    assert.equal(store.autoUnlock(), true);
    for (const name of fs.readdirSync(store.dataDir)) {
        const file = path.join(store.dataDir, name);
        if (fs.statSync(file).isFile()) assert(!fs.readFileSync(file, "utf8").includes(PW), name);
    }
    store.setSettings({
        rememberPassword: false
    });
    store.lock();
    assert.equal(store.autoUnlock(), false);
});

test("password remembering is unavailable on unsupported platforms", t => {
    const keyring = new Keyring(path.join(os.tmpdir(), "vaultos-unused"), {
        platform: "win32",
        env: {}
    });
    assert.equal(keyring.describe().secure, false);
    assert.equal(keyring.get(), null);
    assert.throws(() => keyring.set(PW), /unavailable/);
    assert.doesNotThrow(() => keyring.clear());
});

test("default data directories keep the preview namespace on each platform", () => {
    const home = "/home/synthetic";
    assert.equal(defaultDataDir({
        platform: "darwin",
        env: {},
        home: home
    }), path.join(home, "Library", "Application Support", "VaultOS-Preview"));
    assert.equal(defaultDataDir({
        platform: "linux",
        env: {},
        home: home
    }), path.join(home, ".config", "VaultOS-Preview"));
    assert.equal(defaultDataDir({
        platform: "linux",
        env: {
            XDG_CONFIG_HOME: "/xdg/config"
        },
        home: home
    }), path.join("/xdg/config", "VaultOS-Preview"));
    assert.equal(defaultDataDir({
        platform: "linux",
        env: {
            XDG_CONFIG_HOME: "relative/config"
        },
        home: home
    }), path.join(home, ".config", "VaultOS-Preview"));
    assert.equal(defaultDataDir({
        platform: "linux",
        env: {
            VAULTOS_DATA_DIR: "/synthetic/data"
        },
        home: home
    }), "/synthetic/data");
    assert.throws(() => defaultDataDir({
        platform: "linux",
        env: {
            VAULTOS_DATA_DIR: "relative/data"
        },
        home: home
    }), /absolute/);
});
