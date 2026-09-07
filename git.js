"use strict";

const {execFileSync: execFileSync} = require("node:child_process");

const fs = require("node:fs");

const path = require("node:path");

function git(repo, args, {timeout: timeout = 6e4} = {}) {
    try {
        const stdout = execFileSync("git", [ "-c", "core.hooksPath=/dev/null", "-C", repo, ...args ], {
            encoding: "utf8",
            timeout: timeout,
            stdio: [ "ignore", "pipe", "pipe" ],
            env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: "0",
                GIT_ASKPASS: "/bin/true",
                SSH_ASKPASS: "/bin/true"
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

class GitRepo {
    constructor(dir) {
        this.dir = dir;
    }
    isRepo() {
        return fs.existsSync(path.join(this.dir, ".git"));
    }
    branch() {
        const r = git(this.dir, [ "rev-parse", "--abbrev-ref", "HEAD" ]);
        return r.ok ? r.out : null;
    }
    remoteName() {
        const r = git(this.dir, [ "remote" ]);
        if (!r.ok || !r.out) return null;
        const names = r.out.split("\n").map(s => s.trim()).filter(Boolean);
        return names.includes("origin") ? "origin" : names[0] || null;
    }
    head() {
        const r = git(this.dir, [ "rev-parse", "HEAD" ]);
        return r.ok ? r.out : null;
    }
    dirty() {
        const r = git(this.dir, [ "status", "--porcelain" ]);
        if (!r.ok) return {
            ok: false,
            error: r.error
        };
        const files = r.out ? r.out.split("\n").filter(Boolean) : [];
        return {
            ok: true,
            dirty: files.length > 0,
            files: files
        };
    }
    fetch() {
        const remote = this.remoteName();
        if (!remote) return {
            ok: false,
            error: "no git remote configured",
            code: "NO_REMOTE"
        };
        const r = git(this.dir, [ "fetch", "--quiet", remote ]);
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
    commitPaths(paths, message) {
        const pre = git(this.dir, [ "diff", "--cached", "--name-only" ]);
        if (!pre.ok || pre.out.split("\n").filter(Boolean).some(f => !paths.some(p => f === p || f.startsWith(p + "/")))) return {
            ok: false,
            error: "Unrelated staged files; refusing to commit"
        };
        const add = git(this.dir, [ "add", "--", ...paths ]);
        if (!add.ok) return {
            ok: false,
            error: add.error
        };
        const staged = git(this.dir, [ "diff", "--cached", "--name-only" ]);
        if (!staged.ok) return {
            ok: false,
            error: staged.error
        };
        if (!staged.out) return {
            ok: true,
            committed: false,
            sha: this.head()
        };
        const c = git(this.dir, [ "commit", "-m", message ]);
        if (!c.ok) return {
            ok: false,
            error: c.error
        };
        return {
            ok: true,
            committed: true,
            sha: this.head()
        };
    }
    rebaseOnRemote() {
        const branch = this.branch(), remote = this.remoteName();
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
    push() {
        const branch = this.branch(), remote = this.remoteName();
        if (!remote) return {
            ok: false,
            error: "no git remote configured",
            code: "NO_REMOTE"
        };
        let r = git(this.dir, [ "push", remote, `HEAD:${branch}` ]);
        if (!r.ok) {
            const f = this.fetch();
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
            r = git(this.dir, [ "push", remote, `HEAD:${branch}` ]);
        }
        if (!r.ok) return {
            ok: false,
            error: r.error,
            code: "PUSH_REJECTED"
        };
        const readback = git(this.dir, [ "fetch", "--quiet", remote ]);
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
    pullFF() {
        const f = this.fetch();
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
                code: "GIT_HISTORY_DIVERGED",
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
    GitRepo: GitRepo
};
