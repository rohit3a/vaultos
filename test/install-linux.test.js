"use strict";

const {test: test} = require("node:test"), assert = require("node:assert/strict");

const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), {spawnSync: spawnSync} = require("node:child_process");

const script = path.resolve(__dirname, "..", "scripts", "install-linux.sh");

// On macOS, stand-ins for Linux's uname and GNU stat let the installer's logic run in CI there too.
const DARWIN_SHIMS = {
    uname: `#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) /usr/bin/uname "$@" ;; esac\n`,
    stat: `#!/bin/sh\n[ "$1" = -c ] && [ "$2" = %u ] && exec /usr/bin/stat -f %u "$3"\nexec /usr/bin/stat "$@"\n`
};

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vaultos-install-"));
    t.after(() => fs.rmSync(dir, {
        recursive: true,
        force: true
    }));
    const shims = path.join(dir, "shims"), log = path.join(dir, "log");
    fs.mkdirSync(shims);
    fs.mkdirSync(log);
    const write = (file, body) => fs.writeFileSync(file, body, {
        mode: 448
    });
    if (process.platform === "darwin") for (const [name, body] of Object.entries(DARWIN_SHIMS)) write(path.join(shims, name), body);
    write(path.join(shims, "systemctl"), `#!/bin/sh\necho "$*" >> "${log}/systemctl"\n`);
    write(path.join(shims, "sudo"), `#!/bin/sh\necho "$*" >> "${log}/sudo"\n`);
    const arch = process.platform === "darwin" || process.arch !== "arm64" ? "x64" : "arm64";
    const build = path.join(dir, "build", `vaultos-preview-linux-${arch}`);
    fs.mkdirSync(path.join(build, "resources"), {
        recursive: true
    });
    write(path.join(build, "vaultos-preview"), `#!/bin/sh\necho "$*" > "${log}/launched"\n`);
    fs.writeFileSync(path.join(build, "resources", "app.asar"), "synthetic");
    fs.writeFileSync(path.join(build, "chrome-sandbox"), "synthetic");
    fs.writeFileSync(path.join(build, "vaultos-preview.png"), "synthetic");
    const env = {
        HOME: path.join(dir, "home"),
        XDG_DATA_HOME: path.join(dir, "data-home"),
        XDG_CONFIG_HOME: path.join(dir, "config-home"),
        PATH: [ shims, path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin" ].join(path.delimiter)
    };
    fs.mkdirSync(env.HOME);
    const run = (...args) => spawnSync("bash", [ script, "--from", build, ...args ], {
        env: env,
        encoding: "utf8"
    });
    return {
        dir: dir,
        log: log,
        env: env,
        run: run,
        prefix: path.join(dir, "home", ".local", "opt", "vaultos-preview")
    };
}

test("Linux installer writes the app, launcher and desktop entry without root or a service", {
    skip: process.platform === "win32"
}, t => {
    const {log: log, env: env, run: run, prefix: prefix} = fixture(t);
    for (let i = 0; i < 2; i++) {
        const r = run();
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /service\s+not installed/);
    }
    assert(fs.statSync(path.join(prefix, "vaultos-preview.sh")).mode & 64);
    const desktop = fs.readFileSync(path.join(env.XDG_DATA_HOME, "applications", "org.vaultos.preview.desktop"), "utf8");
    assert(desktop.includes(`Exec="${prefix}/vaultos-preview.sh"`));
    assert(desktop.includes(`Icon=${prefix}/vaultos-preview.png`));
    assert(!fs.existsSync(path.join(env.XDG_CONFIG_HOME, "systemd")));
    assert(!fs.existsSync(path.join(log, "systemctl")));
    assert(!fs.existsSync(path.join(log, "sudo")));
    assert.deepEqual(fs.readdirSync(path.dirname(prefix)), [ "vaultos-preview" ]);
    const launched = spawnSync(path.join(prefix, "vaultos-preview.sh"), [ "--example" ], {
        env: env,
        encoding: "utf8"
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(fs.readFileSync(path.join(log, "launched"), "utf8"), /--example/);
});

test("Linux installer refuses to replace a folder that is not a VaultOS install", {
    skip: process.platform === "win32"
}, t => {
    const {dir: dir, run: run} = fixture(t);
    const other = path.join(dir, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "keep.txt"), "synthetic");
    const r = run("--prefix", other);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not a VaultOS Preview install/);
    assert.deepEqual(fs.readdirSync(other), [ "keep.txt" ]);
    assert.notEqual(run("--prefix", "relative/path").status, 0);
});

test("Linux installer verifies an archive checksum before installing it", {
    skip: process.platform === "win32"
}, t => {
    const {dir: dir, env: env, prefix: prefix} = fixture(t);
    const build = path.join(dir, "build"), archive = path.join(dir, "vaultos-linux.tar.gz");
    const [folder] = fs.readdirSync(build);
    assert.equal(spawnSync("tar", [ "-czf", archive, "-C", build, folder ]).status, 0);
    const install = () => spawnSync("bash", [ script, "--from", archive ], {
        env: env,
        encoding: "utf8"
    });
    fs.writeFileSync(archive + ".sha256", "0".repeat(64) + "  vaultos-linux.tar.gz\n");
    assert.notEqual(install().status, 0);
    assert(!fs.existsSync(prefix));
    const digest = require("node:crypto").createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
    fs.writeFileSync(archive + ".sha256", digest + "  vaultos-linux.tar.gz\n");
    const r = install();
    assert.equal(r.status, 0, r.stderr);
    assert(fs.existsSync(path.join(prefix, "resources", "app.asar")));
});

test("Linux installer writes and enables the backend unit only with --enable-service", {
    skip: process.platform === "win32" || !fs.existsSync(path.resolve(__dirname, "..", "node_modules"))
}, t => {
    const {log: log, env: env, run: run} = fixture(t);
    const r = run("--enable-service");
    assert.equal(r.status, 0, r.stderr);
    const unit = fs.readFileSync(path.join(env.XDG_CONFIG_HOME, "systemd", "user", "vaultos-preview-backend.service"), "utf8");
    const node = spawnSync("sh", [ "-c", "command -v node" ], {
        env: env,
        encoding: "utf8"
    }).stdout.trim();
    assert(unit.includes(`ExecStart="${node}" "${path.resolve(__dirname, "..", "backend.cjs")}" --service`));
    assert(!/@[A-Z]+@/.test(unit));
    assert.equal(fs.readFileSync(path.join(log, "systemctl"), "utf8"), "--user daemon-reload\n--user enable --now vaultos-preview-backend.service\n");
});
