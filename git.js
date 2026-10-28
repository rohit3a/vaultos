"use strict";

const {execFileSync: execFileSync, spawn: spawn} = require("node:child_process");

const crypto = require("node:crypto");

const fs = require("node:fs");

const os = require("node:os");

const path = require("node:path");

const GIT_ENV = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
    SSH_ASKPASS: "/bin/true"
};

const gitArgs = (repo, args) => [ "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args ];

// Every path VaultOS hands Git is a file or folder name, never a pattern. Without
// --literal-pathspecs a stray file named `records/*` would match every record.
function git(repo, args, {timeout: timeout = 6e4} = {}) {
    try {
        const stdout = execFileSync("git", gitArgs(repo, args), {
            encoding: "utf8",
            timeout: timeout,
            stdio: [ "ignore", "pipe", "pipe" ],
            env: {
                ...process.env,
                ...GIT_ENV
            }
        });
        return {
            ok: true,
            out: (stdout || "").trimEnd()
        };
    } catch (e) {
        const err = [ e.stderr, e.stdout, e.message ].filter(Boolean).join(" ").trim();
        return {
            ok: false,
            out: "",
            error: err.split("\n").slice(0, 4).join(" ")
        };
    }
}

// Fetch and push wait on the network, often for seconds over SSH. They run without blocking,
// so the owning process (in the desktop app, the one that draws the window) stays responsive.
// Local Git commands take milliseconds and keep the synchronous runner above.
function gitAsync(repo, args, {timeout: timeout = 6e4, env: env = {}} = {}) {
    return new Promise(resolve => {
        const out = [], err = [];
        let settled = false;
        const finish = (code, error) => {
            if (settled) return;
            settled = true;
            const stdout = Buffer.concat(out).toString("utf8"), stderr = Buffer.concat(err).toString("utf8");
            if (code === 0 && !error) return resolve({
                ok: true,
                out: stdout.trimEnd()
            });
            const message = [ stderr, stdout, error ? error.message : `git exited with ${code}` ].filter(Boolean).join(" ").trim();
            resolve({
                ok: false,
                out: "",
                error: message.split("\n").slice(0, 4).join(" ")
            });
        };
        const child = spawn("git", gitArgs(repo, args), {
            timeout: timeout,
            stdio: [ "ignore", "pipe", "pipe" ],
            env: {
                ...process.env,
                ...GIT_ENV,
                ...env
            }
        });
        child.stdout.on("data", d => out.push(d));
        child.stderr.on("data", d => err.push(d));
        child.on("error", e => finish(null, e));
        child.on("close", (code, signal) => finish(code, signal ? new Error(`git stopped by ${signal}; the remote may have timed out`) : null));
        // A persisted SSH master may hold an inherited pipe open after git itself has exited.
        child.on("exit", code => setTimeout(() => finish(code), 2e3).unref());
    });
}

// One sync round fetches, pushes and fetches again to verify the push. Over SSH each of those
// was a separate handshake. A private control socket per remote lets them share one connection,
// and keeps it for a few minutes so the next autosync round reuses it too. Anything the user
// configured for SSH wins, and an unsafe socket directory turns reuse off rather than risking it.
function sshReuseEnv(repo, remote) {
    if (process.platform === "win32" || typeof process.getuid !== "function") return {};
    if (process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) return {};
    const configured = git(repo, [ "config", "--get", "core.sshCommand" ]);
    if (configured.ok && configured.out) return {};
    const url = git(repo, [ "remote", "get-url", remote ]);
    if (!url.ok || !url.out) return {};
    const dir = path.join(os.tmpdir(), `vaultos-ssh-${process.getuid()}`);
    if (!/^[A-Za-z0-9._\/-]+$/.test(dir)) return {};
    try {
        fs.mkdirSync(dir, {
            mode: 448
        });
    } catch (e) {
        if (e.code !== "EEXIST") return {};
    }
    try {
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 63) !== 0) return {};
    } catch {
        return {};
    }
    const socket = path.join(dir, crypto.createHash("sha256").update(url.out, "utf8").digest("hex").slice(0, 16));
    return {
        GIT_SSH_COMMAND: `ssh -o ControlMaster=auto -o ControlPersist=300 -o ControlPath=${socket}`
    };
}

class GitRepo {
    constructor(dir) {
        this.dir = dir;
    }
    sshEnv(remote) {
        if (!this.ssh || this.ssh.remote !== remote) this.ssh = {
            remote: remote,
            env: sshReuseEnv(this.dir, remote)
        };
        return this.ssh.env;
    }
    isRepo() {
        return fs.existsSync(path.join(this.dir, ".git"));
    }
    // A GitRepo lives for one sync call, and a round asked for these a dozen times, each a
    // separate git process. Found values are kept for that call; a missing one is asked again.
    branch() {
        if (this.branchName) return this.branchName;
        const r = git(this.dir, [ "rev-parse", "--abbrev-ref", "HEAD" ]);
        return r.ok && r.out ? this.branchName = r.out : null;
    }
    remoteName() {
        if (this.remote) return this.remote;
        const r = git(this.dir, [ "remote" ]);
        if (!r.ok || !r.out) return null;
        const names = r.out.split("\n").map(s => s.trim()).filter(Boolean);
        return this.remote = names.includes("origin") ? "origin" : names[0] || null;
    }
    head() {
        const r = git(this.dir, [ "rev-parse", "HEAD" ]);
        return r.ok ? r.out : null;
    }
    // The files under these paths that Git tracks, committed or staged.
    trackedPaths(paths) {
        const r = git(this.dir, [ "ls-files", "-z", "--", ...paths ]);
        if (!r.ok) return {
            ok: false,
            error: r.error
        };
        return {
            ok: true,
            files: new Set(r.out.split("\0").filter(Boolean))
        };
    }
    // The untracked files under these paths that Git's ignore rules hide from `git status`.
    ignoredPaths(paths) {
        const r = git(this.dir, [ "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...paths ]);
        if (!r.ok) return {
            ok: false,
            error: r.error
        };
        return {
            ok: true,
            files: r.out.split("\0").filter(Boolean)
        };
    }
    // Each path that differs from HEAD, staged or not, as a plain repository path. Files in an
    // untracked directory are listed one by one.
    changedPaths() {
        const r = git(this.dir, [ "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all" ]);
        if (!r.ok) return {
            ok: false,
            error: r.error
        };
        return {
            ok: true,
            files: r.out.split("\0").filter(Boolean).map(entry => entry.slice(3))
        };
    }
    async fetch() {
        const remote = this.remoteName();
        if (!remote) return {
            ok: false,
            error: "no git remote configured",
            code: "NO_REMOTE"
        };
        const r = await gitAsync(this.dir, [ "fetch", "--quiet", remote ], {
            env: this.sshEnv(remote)
        });
        if (!r.ok) return {
            ok: false,
            error: r.error,
            code: "REMOTE_UNREACHABLE"
        };
        return {
            ok: true,
            remote: remote
        };
    }
    divergence() {
        const branch = this.branch();
        const remote = this.remoteName();
        if (!branch || !remote) return {
            ok: false,
            error: "no branch or remote"
        };
        const r = git(this.dir, [ "rev-list", "--left-right", "--count", `${remote}/${branch}...HEAD` ]);
        if (!r.ok) return {
            ok: false,
            error: r.error
        };
        const [behind, ahead] = r.out.split(/\s+/).map(n => parseInt(n, 10) || 0);
        return {
            ok: true,
            ahead: ahead,
            behind: behind,
            branch: branch,
            remote: remote
        };
    }
    remoteHead() {
        const branch = this.branch(), remote = this.remoteName();
        if (!branch || !remote) return null;
        const r = git(this.dir, [ "rev-parse", `${remote}/${branch}` ]);
        return r.ok ? r.out : null;
    }
    // Commits `paths` as they are in the working tree, and removes `untrack` from the
    // repository while leaving those files on disk.
    commitPaths(paths, message, {untrack: untrack = []} = {}) {
        const all = [ ...paths, ...untrack ];
        // With no paths, `git add --` adds nothing but `git reset --` would unstage everything.
        if (!all.length) return {
            ok: true,
            committed: false,
            sha: this.head()
        };
        const pre = git(this.dir, [ "diff", "--cached", "--name-only" ]);
        if (!pre.ok) return {
            ok: false,
            error: pre.error
        };
        const unrelated = pre.out.split("\n").filter(f => f && !all.some(p => f === p || f.startsWith(p + "/")));
        if (unrelated.length) return {
            ok: false,
            error: `Unrelated staged files; refusing to commit: ${unrelated.slice(0, 3).join(", ")}`
        };
        // A failure after `git add` unstages the paths again. Left staged, they made the next
        // commit of other paths refuse, and Git does not rebase over staged changes.
        const fail = error => {
            git(this.dir, [ "reset", "--quiet", "--", ...all ]);
            return {
                ok: false,
                error: error
            };
        };
        const add = paths.length ? git(this.dir, [ "add", "--", ...paths ]) : {
            ok: true
        };
        if (!add.ok) return fail(add.error);
        const rm = untrack.length ? git(this.dir, [ "rm", "--cached", "--quiet", "--ignore-unmatch", "-r", "--", ...untrack ]) : {
            ok: true
        };
        if (!rm.ok) return fail(rm.error);
        const staged = git(this.dir, [ "diff", "--cached", "--name-only" ]);
        if (!staged.ok) return fail(staged.error);
        if (!staged.out) return {
            ok: true,
            committed: false,
            sha: this.head()
        };
        const c = git(this.dir, [ "commit", "-m", message ]);
        if (!c.ok) return fail(c.error);
        return {
            ok: true,
            committed: true,
            sha: this.head()
        };
    }
    rebaseOnRemote() {
        const branch = this.branch(), remote = this.remoteName();
        // Git refuses to rebase over uncommitted changes to tracked files. That is a dirty
        // checkout, not diverged history, and is reported as one.
        const tracked = git(this.dir, [ "status", "--porcelain=v1", "--untracked-files=no" ]);
        if (tracked.ok && tracked.out) return {
            ok: false,
            code: "LOCAL_SYNC_REPO_DIRTY",
            error: `uncommitted changes block the rebase: ${tracked.out.split("\n").slice(0, 3).map(f => f.slice(3)).join(", ")}`
        };
        const r = git(this.dir, [ "rebase", `${remote}/${branch}` ]);
        if (r.ok) return {
            ok: true
        };
        git(this.dir, [ "rebase", "--abort" ]);
        return {
            ok: false,
            code: "GIT_HISTORY_DIVERGED",
            error: r.error
        };
    }
    async push() {
        const branch = this.branch(), remote = this.remoteName();
        if (!remote) return {
            ok: false,
            error: "no git remote configured",
            code: "NO_REMOTE"
        };
        const env = this.sshEnv(remote);
        let r = await gitAsync(this.dir, [ "push", remote, `HEAD:${branch}` ], {
            env: env
        });
        if (!r.ok) {
            const f = await this.fetch();
            if (!f.ok) return {
                ok: false,
                error: f.error,
                code: "REMOTE_UNREACHABLE"
            };
            const rb = this.rebaseOnRemote();
            if (!rb.ok) return {
                ok: false,
                error: rb.error,
                code: rb.code
            };
            r = await gitAsync(this.dir, [ "push", remote, `HEAD:${branch}` ], {
                env: env
            });
        }
        if (!r.ok) return {
            ok: false,
            error: r.error,
            code: "PUSH_REJECTED"
        };
        const readback = await gitAsync(this.dir, [ "fetch", "--quiet", remote ], {
            env: env
        });
        if (!readback.ok || this.remoteHead() !== this.head()) return {
            ok: false,
            error: "Could not verify remote receipt",
            code: "RECEIPT_UNVERIFIED"
        };
        return {
            ok: true,
            remoteSha: this.remoteHead()
        };
    }
    async pullFF() {
        const f = await this.fetch();
        if (!f.ok) return f;
        const div = this.divergence();
        if (!div.ok) return {
            ok: false,
            error: div.error
        };
        if (div.behind === 0) return {
            ok: true,
            changed: false,
            ahead: div.ahead,
            behind: 0
        };
        if (div.ahead > 0) {
            const rb = this.rebaseOnRemote();
            if (!rb.ok) return {
                ok: false,
                code: rb.code,
                error: rb.error
            };
            return {
                ok: true,
                changed: true,
                rebased: div.ahead,
                behind: div.behind,
                head: this.head()
            };
        }
        const r = git(this.dir, [ "merge", "--ff-only", `${div.remote}/${div.branch}` ]);
        if (!r.ok) return {
            ok: false,
            code: "GIT_HISTORY_DIVERGED",
            error: r.error
        };
        return {
            ok: true,
            changed: true,
            behind: div.behind,
            head: this.head()
        };
    }
}

module.exports = {
    GitRepo: GitRepo,
    sshReuseEnv: sshReuseEnv
};
