"use strict";

const $app = document.getElementById("app");

let PROVIDERS = [];

let view = {
    name: "loading"
};

let renderVersion = 0;

const el = h => {
    const t = document.createElement("template");
    t.innerHTML = h.trim();
    return t.content.firstElementChild;
};

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
}[c]));

const providerById = id => PROVIDERS.find(p => p.id === id) || PROVIDERS.find(p => p.id === "custom");

let AGENTS = [];

let TOUCH_ID = {
    available: false,
    enabled: false,
    ready: false,
    autoPrompt: false
};

const agentLabel = ref => {
    const a = AGENTS.find(x => x.ref === ref);
    return a ? a.name : (ref || "").replace(/^agent:/, "agent ");
};

// ── Dial ───────────────────────────────────────────────────────────────────
// The vault-door mascot from the marketing mini-game (hero-game/render.ts), as a
// static inline SVG. It appears only on the unlock/create-vault screen and,
// small, in the "no projects yet" empty state.
const DIAL = {
    rim: "#e2541c",
    door: "#ff9658",
    bolt: "#ffd2ad",
    nose: "#fff2dc",
    cheek: "rgba(255,111,143,0.55)"
};

function dialSvg(cls = "dial") {
    const eye = side => `<ellipse cx="${side * 15}" cy="-15" rx="7.5" ry="9.5" fill="#fff" class="sp-o" stroke-width="2.4"/><circle cx="${side * 15}" cy="-13.5" r="4" class="sp-i"/><circle cx="${side * 15 + 1.4}" cy="-15.4" r="1.3" fill="#fff"/>`;
    const ticks = Array.from({
        length: 12
    }, (_, i) => {
        const a = i / 12 * Math.PI * 2, inner = i % 3 === 0 ? 7.5 : 9.5;
        return `<line x1="${(Math.cos(a) * inner).toFixed(2)}" y1="${(Math.sin(a) * inner).toFixed(2)}" x2="${(Math.cos(a) * 11.2).toFixed(2)}" y2="${(Math.sin(a) * 11.2).toFixed(2)}" stroke="#6b5a7a" stroke-width="1.4" stroke-linecap="round"/>`;
    }).join("");
    const bolts = Array.from({
        length: 10
    }, (_, i) => {
        const a = i / 10 * Math.PI * 2;
        return `<circle cx="${(Math.cos(a) * 44).toFixed(1)}" cy="${(Math.sin(a) * 44).toFixed(1)}" r="2.7" fill="${DIAL.bolt}"/>`;
    }).join("");
    const legs = [ -1, 1 ].map(s => `<rect x="${s * 20 - 7}" y="42" width="14" height="18" rx="6" fill="${DIAL.rim}" class="sp-o" stroke-width="2.6"/><ellipse cx="${s * 23}" cy="60" rx="12" ry="6.5" fill="${DIAL.rim}" class="sp-o" stroke-width="2.6"/>`).join("");
    const arms = [ -1, 1 ].map(s => `<g transform="translate(${s * 51} 12) rotate(${s * 28.6})"><ellipse cx="0" cy="6" rx="7.5" ry="13" fill="${DIAL.rim}" class="sp-o" stroke-width="2.6"/></g>`).join("");
    const hinges = [ -17, 17 ].map(y => `<rect x="-46" y="${y - 5}" width="9" height="10" rx="3" fill="${DIAL.bolt}" class="sp-o" stroke-width="2"/>`).join("");
    return `<svg class="${cls}" viewBox="-68 -58 136 142" aria-hidden="true" focusable="false">` + `<ellipse cx="0" cy="64" rx="51" ry="11" fill="rgba(80,35,30,0.16)"/>${legs}${arms}` + `<circle r="50" fill="${DIAL.rim}" class="sp-o" stroke-width="3.5"/>${bolts}<circle r="39" fill="${DIAL.door}" class="sp-o" stroke-width="3"/>${hinges}` + `${eye(-1)}${eye(1)}<ellipse cx="-26" cy="7" rx="6" ry="3.6" fill="${DIAL.cheek}"/><ellipse cx="26" cy="7" rx="6" ry="3.6" fill="${DIAL.cheek}"/>` + `<g transform="translate(0 5)"><circle r="13" fill="${DIAL.nose}" class="sp-o" stroke-width="2.6"/>${ticks}<line x1="0" y1="0" x2="0" y2="-8" stroke="${DIAL.rim}" stroke-width="3" stroke-linecap="round"/><circle r="3" fill="${DIAL.rim}"/></g>` + `<path class="sp-o" d="M5.66 25.1A7 7 0 0 1 -5.66 25.1" fill="none" stroke-width="2.6"/></svg>`;
}

// A flat vault-door glyph for the header: ring, dial and one tick.
const GLYPH = `<svg class="glyph" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.5" fill="var(--orange)" stroke="currentColor" stroke-width="1.5"/><path d="M12 7.5V5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

// A titled card. Returns its body.
function panel(parent, title, {tag: tag = ""} = {}) {
    const card = el(`<section class="card"><div class="card-head"><h3 class="card-title"></h3>${tag ? `<span class="pname"></span>` : ""}</div><div class="card-body"></div></section>`);
    card.querySelector(".card-title").textContent = title;
    if (tag) card.querySelector(".pname").textContent = tag;
    parent.appendChild(card);
    return card.querySelector(".card-body");
}

function detectProvider(keyName) {
    if (!keyName) return "custom";
    const up = keyName.toUpperCase();
    for (const p of PROVIDERS) if ((p.keys || []).includes(up)) return p.id;
    for (const p of PROVIDERS) {
        if (p.id === "custom") continue;
        if (up.includes(p.id.toUpperCase())) return p.id;
    }
    return "custom";
}

async function boot() {
    PROVIDERS = await window.vault.providers();
    const s = await window.vault.state();
    document.documentElement.dataset.platform = s.isMac ? "mac" : "other";
    TOUCH_ID = s.touchId || TOUCH_ID;
    // Touch ID is offered automatically only when the window opens, never right after Lock.
    view = s.exists ? {
        name: "unlock",
        auto: TOUCH_ID.autoPrompt
    } : {
        name: "setup"
    };
    render();
}

async function refreshAgents() {
    try {
        AGENTS = await window.vault.agents();
    } catch {
        AGENTS = [];
    }
}

function topbar({crumb: crumb} = {}) {
    const bar = el(`<div class="topbar"></div>`);
    if (crumb) {
        const c = el(`<span class="crumb">‹ ${esc(crumb.label)}</span>`);
        c.onclick = crumb.onClick;
        bar.appendChild(c);
    }
    bar.appendChild(el(`<div class="wordmark">${GLYPH}<span class="wm">VAULT<span class="dot">.</span>OS</span></div>`));
    bar.appendChild(el(`<div class="status" title="Vault unlocked"><span class="led"></span><span class="st">Unlocked</span></div>`));
    const gear = el(`<button class="iconbtn gear" title="Settings"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>`);
    gear.onclick = () => {
        view = {
            name: "settings"
        };
        render();
    };
    bar.appendChild(gear);
    const lock = el(`<button class="iconbtn">Lock</button>`);
    lock.onclick = async () => {
        await window.vault.lock();
        view = {
            name: "unlock"
        };
        render();
    };
    bar.appendChild(lock);
    return bar;
}

function render() {
    renderVersion++;
    $app.innerHTML = "";
    const fn = {
        loading: renderLoading,
        setup: renderSetup,
        unlock: renderUnlock,
        projects: renderProjects,
        project: renderProject,
        secret: renderSecret,
        history: renderHistory,
        settings: renderSettings,
        agents: renderAgents,
        delegate: renderDelegate,
        sync: renderSync
    }[view.name] || renderLoading;
    fn();
}

function renderLoading() {
    $app.appendChild(el(`<div class="center"><p>Loading…</p></div>`));
}

function renderSetup() {
    const wrap = el(`<div class="center"></div>`);
    wrap.appendChild(el(dialSvg("dial hero")));
    wrap.appendChild(el(`<h1>Set up your vault</h1>`));
    wrap.appendChild(el(`<p>One master password encrypts everything. It stays in memory while unlocked. Optional Keychain access can be enabled later. <strong>Keep the password safe; there is no password reset.</strong></p>`));
    const pw = el(`<input type="password" placeholder="Master password" />`);
    const pw2 = el(`<input type="password" placeholder="Confirm password" />`);
    const err = el(`<div class="err"></div>`);
    const btn = el(`<button class="btn">Create vault</button>`);
    btn.onclick = async () => {
        if (pw.value.length < 12) return err.textContent = "Use at least 12 characters.";
        if (pw.value !== pw2.value) return err.textContent = "Passwords do not match.";
        try {
            const result = await window.vault.init(pw.value);
            if (!result.ok) {
                err.textContent = result.error;
                return;
            }
        } catch (e) {
            err.textContent = e.message;
            return;
        }
        pw.value = pw2.value = "";
        view = {
            name: "projects"
        };
        render();
    };
    pw2.addEventListener("keydown", e => {
        if (e.key === "Enter") btn.click();
    });
    [ pw, pw2, err, btn ].forEach(n => wrap.appendChild(n));
    $app.appendChild(wrap);
    pw.focus();
}

async function renderUnlock() {
    const revision = renderVersion;
    // Touch ID can come and go (lid closed, lockout, a manual Lock), so ask each time.
    TOUCH_ID = (await window.vault.state()).touchId || TOUCH_ID;
    if (revision !== renderVersion) return;
    const wrap = el(`<div class="center"></div>`);
    wrap.appendChild(el(dialSvg("dial hero")));
    wrap.appendChild(el(`<div class="kicker">Welcome back. Ready when you are.</div>`));
    wrap.appendChild(el(`<h1>VAULT<span class="dot">.</span>OS</h1>`));
    wrap.appendChild(el(`<p>Unlock to let approved agents use your keys. Locks after 15 minutes of inactivity, when the Mac locks, or when you press Lock.</p>`));
    const pw = el(`<input type="password" placeholder="Master password" />`);
    const err = el(`<div class="err"></div>`);
    const btn = el(`<button class="btn">Unlock</button>`);
    btn.onclick = async () => {
        const r = await window.vault.unlock(pw.value);
        if (!r.ok) {
            err.textContent = r.error;
            pw.value = "";
            pw.focus();
            return;
        }
        view = {
            name: "projects"
        };
        render();
    };
    pw.addEventListener("keydown", e => {
        if (e.key === "Enter") btn.click();
    });
    [ pw, err, btn ].forEach(n => wrap.appendChild(n));
    if (TOUCH_ID.ready) {
        const touch = el(`<button class="btn ghost">Unlock with Touch ID</button>`);
        touch.onclick = async () => {
            touch.disabled = true;
            err.textContent = "";
            try {
                const r = await window.vault.unlockTouchId();
                if (r.ok) {
                    view = {
                        name: "projects"
                    };
                    render();
                    return;
                }
                err.textContent = r.error;
            } catch (e) {
                err.textContent = cleanError(e);
            }
            touch.disabled = false;
            pw.focus();
        };
        wrap.appendChild(touch);
        if (view.auto) {
            view.auto = false;
            setTimeout(() => touch.click(), 0);
        }
    } else if (TOUCH_ID.available && TOUCH_ID.enabled) {
        wrap.appendChild(el(`<p class="note">Touch ID returns after you enter the master password once.</p>`));
    }
    $app.appendChild(wrap);
    pw.focus();
}

const cleanError = e => String(e?.message || e || "The operation failed. Please retry.").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

// Human-only actions. With Touch ID confirmation on, the main process asks for Touch ID; when
// it cannot (unavailable, cancelled, or not a Mac) it refuses with NEED_PASSWORD, and the
// master password collected here confirms the action instead. The main process verifies it.
async function human(name, ...args) {
    try {
        return await window.vault[name](...args);
    } catch (e) {
        const msg = cleanError(e);
        if (!msg.startsWith("NEED_PASSWORD")) throw e;
        if (!await askPassword(msg.replace(/^NEED_PASSWORD: /, ""))) throw new Error("Not confirmed, so nothing was done.");
        return window.vault[name](...args);
    }
}

function askPassword(why) {
    return new Promise(resolve => {
        const modal = el(`<div class="modal" role="dialog" aria-modal="true"><div class="box card"><div class="card-head"><h3 class="card-title">Confirm it's you</h3></div><div class="card-body"><div class="note"></div><input type="password" placeholder="Master password" /><div class="err"></div><div class="row2"><button class="btn ghost">Cancel</button><button class="btn">Confirm</button></div></div></div></div>`);
        modal.querySelector(".note").textContent = why;
        const input = modal.querySelector("input"), err = modal.querySelector(".err");
        const [cancel, ok] = modal.querySelectorAll("button");
        const done = result => {
            input.value = "";
            modal.remove();
            resolve(result);
        };
        cancel.onclick = () => done(false);
        ok.onclick = async () => {
            ok.disabled = true;
            try {
                const r = await window.vault.confirmHuman(input.value);
                if (r.ok) return done(true);
                err.textContent = r.error;
            } catch (e) {
                err.textContent = cleanError(e);
            }
            ok.disabled = false;
            input.value = "";
            input.focus();
        };
        input.addEventListener("keydown", e => {
            if (e.key === "Enter") ok.click();
            if (e.key === "Escape") cancel.click();
        });
        document.body.appendChild(modal);
        input.focus();
    });
}

async function renderProjects() {
    const revision = renderVersion;
    $app.appendChild(topbar());
    const scroll = el(`<div class="scroll"></div>`);
    const projects = await window.vault.projects();
    if (revision !== renderVersion) return;
    await refreshAgents();
    if (revision !== renderVersion) return;
    scroll.appendChild(el(`<div class="section"><span class="label">Projects<span class="dot">.</span></span><span class="label">${projects.length}</span></div>`));
    const pending = await window.vault.pending();
    if (revision !== renderVersion) return;
    if (pending.length) {
        const banner = el(`<div class="secret card attn">\n      <div class="head"><span class="key">${pending.length} key${pending.length === 1 ? "" : "s"} awaiting your approval</span></div>\n      <div class="note">Added by an agent. Held back from .env until you approve.</div>\n      <div class="actions"></div></div>`);
        const acts = banner.querySelector(".actions");
        for (const pd of pending.slice(0, 6)) {
            const b = el(`<button class="iconbtn">${esc(pd.project)}/${esc(pd.key)}</button>`);
            b.onclick = () => {
                view = {
                    name: "project",
                    project: pd.project
                };
                render();
            };
            acts.appendChild(b);
        }
        const approveAll = el(`<button class="iconbtn" title="Allow every pending key to be written by inject">Approve all ${pending.length}</button>`);
        let approveArmed = false;
        approveAll.onclick = async () => {
            if (!approveArmed) {
                approveArmed = true;
                approveAll.textContent = `Confirm approving ${pending.length}?`;
                setTimeout(() => {
                    approveArmed = false;
                    approveAll.textContent = `Approve all ${pending.length}`;
                }, 2500);
                return;
            }
            approveAll.disabled = true;
            for (const pd of pending) await human("approveInject", pd.project, pd.key, true);
            render();
        };
        acts.appendChild(approveAll);
        scroll.appendChild(banner);
    }
    const addToggle = el(`<button class="addtoggle"><span class="plus">+</span> New project</button>`);
    const addForm = el(`<div class="addrow" style="display:none"></div>`);
    const nameInput = el(`<input type="text" placeholder="Project name" />`);
    const addBtn = el(`<button class="btn sm">Add</button>`);
    const doAdd = async () => {
        const n = nameInput.value.trim();
        if (!n) {
            nameInput.focus();
            return;
        }
        await window.vault.createProject(n);
        if (revision !== renderVersion) return;
        view = {
            name: "project",
            project: n
        };
        render();
    };
    addBtn.onclick = doAdd;
    nameInput.addEventListener("keydown", e => {
        if (e.key === "Enter") doAdd();
        if (e.key === "Escape") {
            addForm.style.display = "none";
            addToggle.style.display = "flex";
        }
    });
    addForm.appendChild(nameInput);
    addForm.appendChild(addBtn);
    addToggle.onclick = () => {
        addToggle.style.display = "none";
        addForm.style.display = "flex";
        nameInput.focus();
    };
    scroll.appendChild(addToggle);
    scroll.appendChild(addForm);
    if (!projects.length) {
        scroll.appendChild(el(`<div class="empty">${dialSvg("dial sm")}<div class="big">No projects yet</div><p>Create one, then add its API keys. To let an agent use them, enrol it under Settings, then Agents. Reveal is off by default.</p></div>`));
    }
    for (const p of projects) {
        const logos = (p.providers.length ? p.providers : [ "custom" ]).slice(0, 5).map(id => providerById(id).svg).join("");
        const row = el(`<div class="row">\n      <div class="logos">${logos}</div>\n      <div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${p.secretCount} ${p.secretCount === 1 ? "key" : "keys"}</div></div>\n      <div class="chev">›</div></div>`);
        row.onclick = () => {
            view = {
                name: "project",
                project: p.name
            };
            render();
        };
        scroll.appendChild(row);
    }
    $app.appendChild(scroll);
}

async function renderProject() {
    const revision = renderVersion;
    const project = view.project;
    await refreshAgents();
    if (revision !== renderVersion) return;
    $app.appendChild(topbar({
        crumb: {
            label: "Projects",
            onClick: () => {
                view = {
                    name: "projects"
                };
                render();
            }
        }
    }));
    const scroll = el(`<div class="scroll"></div>`);
    const secrets = await window.vault.secrets(project);
    if (revision !== renderVersion) return;
    scroll.appendChild(el(`<div class="section"><span class="label">${esc(project)}</span><span class="label">${secrets.length} ${secrets.length === 1 ? "key" : "keys"}</span></div>`));
    const actionRow = el(`<div class="actionrow"></div>`);
    const add = el(`<button class="btn"><span aria-hidden="true">+</span> Add key</button>`);
    add.onclick = () => {
        view = {
            name: "secret",
            project: project,
            secret: null
        };
        render();
    };
    const exp = el(`<button class="btn ghost sm" style="flex:0 0 auto" title="Export as password-protected PDF">Export</button>`);
    exp.onclick = async () => {
        exp.textContent = "Exporting…";
        const r = await human("exportProject", project);
        if (revision !== renderVersion) return;
        if (r.ok) {
            exp.textContent = "Exported ✓";
            exp.classList.add("copied");
        } else if (r.canceled) {
            exp.textContent = "Export";
        } else {
            exp.textContent = "Export";
            expErr.textContent = r.error || "Export failed.";
        }
        setTimeout(() => {
            exp.textContent = "Export";
            exp.classList.remove("copied");
        }, 2e3);
    };
    actionRow.appendChild(add);
    actionRow.appendChild(exp);
    scroll.appendChild(actionRow);
    const expErr = el(`<div class="err" style="margin-top:-8px"></div>`);
    scroll.appendChild(expErr);
    if (!secrets.length) scroll.appendChild(el(`<div class="empty"><div class="big">No keys yet</div><p>No keys stored here yet.</p></div>`));
    for (const s of secrets) {
        const prov = providerById(s.provider);
        const sub = [ s.username && `@${esc(s.username)}`, s.email && esc(s.email), s.url && esc(s.url) ].filter(Boolean).join(" · ");
        const badges = [];
        if (s.owner && s.owner !== "human") {
            badges.push(`<span class="badge agent">${esc(agentLabel(s.owner))}</span>`);
        }
        if (s.injectApproved === false) badges.push(`<span class="badge exp-amber">Held from .env</span>`);
        if ((s.editableBy || []).length) badges.push(`<span class="badge perm">Delegated</span>`);
        if (s.permission) badges.push(`<span class="badge perm">${esc(s.permission)}</span>`);
        if (s.expiresAt) {
            const cls = s.expiryStatus === "expired" ? "exp-red" : s.expiryStatus === "expiring" ? "exp-amber" : "exp-grey";
            const txt = s.expiryStatus === "expired" ? "Expired" : s.daysLeft === 0 ? "Expires today" : `Expires in ${s.daysLeft}d`;
            badges.push(`<span class="badge ${cls}">${txt}</span>`);
        }
        const card = el(`<div class="secret card">\n      <div class="head">${prov.svg}<span class="key">${esc(s.key)}</span><span class="pname">${esc(prov.name)}</span></div>\n      ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}\n      ${sub ? `<div class="note">${sub}</div>` : ""}\n      ${s.note ? `<div class="note">${esc(s.note)}</div>` : ""}\n      <div class="val" data-val style="display:none"></div>\n      <div class="actions"></div></div>`);
        const valEl = card.querySelector("[data-val]");
        const actions = card.querySelector(".actions");
        const showBtn = el(`<button class="iconbtn">Reveal</button>`);
        let shown = false;
        showBtn.onclick = async () => {
            if (shown) {
                valEl.textContent = "";
                valEl.style.display = "none";
                showBtn.textContent = "Reveal";
                shown = false;
                return;
            }
            const r = await human("reveal", project, s.key);
            if (revision !== renderVersion) return;
            const lines = [ (s.provider === "password" ? "Password: " : "Value: ") + (r.value || "(empty)") ];
            if (r.password) lines.push("Account pw: " + r.password);
            valEl.textContent = lines.join("\n");
            valEl.style.display = "block";
            showBtn.textContent = "Hide";
            shown = true;
        };
        const copyBtn = el(`<button class="iconbtn">Copy</button>`);
        copyBtn.onclick = async () => {
            await human("copy", project, s.key);
            if (revision !== renderVersion) return;
            copyBtn.textContent = "Copied";
            copyBtn.classList.add("copied");
            setTimeout(() => {
                copyBtn.textContent = "Copy";
                copyBtn.classList.remove("copied");
            }, 1200);
        };
        const editBtn = el(`<button class="iconbtn">Edit</button>`);
        editBtn.onclick = () => {
            view = {
                name: "secret",
                project: project,
                secret: s.key
            };
            render();
        };
        const delBtn = el(`<button class="iconbtn danger">Delete</button>`);
        let armed = false;
        delBtn.onclick = async () => {
            if (!armed) {
                armed = true;
                delBtn.textContent = "Confirm?";
                setTimeout(() => {
                    armed = false;
                    delBtn.textContent = "Delete";
                }, 2500);
                return;
            }
            await window.vault.deleteSecret(project, s.key);
            render();
            if (revision !== renderVersion) return;
        };
        const ownActions = [];
        if (s.injectApproved === false) {
            const okBtn = el(`<button class="iconbtn">Approve for .env</button>`);
            okBtn.onclick = async () => {
                await human("approveInject", project, s.key, true);
                render();
            };
            if (revision !== renderVersion) return;
            ownActions.push(okBtn);
        }
        if (s.owner && s.owner !== "human") {
            const adoptBtn = el(`<button class="iconbtn" title="Take ownership; the agent can no longer change it">Adopt</button>`);
            adoptBtn.onclick = async () => {
                await human("adopt", project, s.key);
                render();
            };
            if (revision !== renderVersion) return;
            ownActions.push(adoptBtn);
        } else if (AGENTS.length) {
            const dlg = el(`<button class="iconbtn" title="Let an agent manage this key">${(s.editableBy || []).length ? "Delegation…" : "Delegate…"}</button>`);
            dlg.onclick = () => {
                view = {
                    name: "delegate",
                    project: project,
                    secret: s.key
                };
                render();
            };
            ownActions.push(dlg);
        }
        [ showBtn, copyBtn, editBtn, ...ownActions, delBtn ].forEach(b => actions.appendChild(b));
        scroll.appendChild(card);
    }
    const del = el(`<button class="btn danger" style="margin-top:18px">Delete project</button>`);
    let armedP = false;
    del.onclick = async () => {
        if (!armedP) {
            armedP = true;
            del.textContent = "Confirm delete project?";
            setTimeout(() => {
                armedP = false;
                del.textContent = "Delete project";
            }, 2800);
            return;
        }
        await window.vault.deleteProject(project);
        view = {
            name: "projects"
        };
        render();
        if (revision !== renderVersion) return;
    };
    scroll.appendChild(del);
    $app.appendChild(scroll);
}

function renderProviderPicker(project) {
    $app.appendChild(topbar({
        crumb: {
            label: project,
            onClick: () => {
                view = {
                    name: "project",
                    project: project
                };
                render();
            }
        }
    }));
    const scroll = el(`<div class="scroll"></div>`);
    scroll.appendChild(el(`<div class="section"><span class="label">Add to ${esc(project)}<span class="dot">.</span></span></div>`));
    scroll.appendChild(el(`<div class="note" style="margin:-4px 2px 12px">Which service is this for?</div>`));
    const grid = el(`<div class="picker-grid"></div>`);
    for (const p of PROVIDERS) {
        const card = el(`<div class="pcard ${p.type !== "keys" ? "special" : ""}"><div class="pcard-logo">${p.svg}</div><div class="pcard-name">${esc(p.name)}</div></div>`);
        card.onclick = () => {
            view = {
                name: "secret",
                project: project,
                secret: null,
                provider: p.id
            };
            render();
        };
        grid.appendChild(card);
    }
    scroll.appendChild(grid);
    $app.appendChild(scroll);
}

async function renderSecret() {
    const revision = renderVersion;
    const {project: project} = view;
    const editing = view.secret;
    let current = null;
    if (editing) {
        const list = await window.vault.secrets(project);
        if (revision !== renderVersion) return;
        const meta = list.find(s => s.key === editing) || {};
        const revealed = await human("reveal", project, editing);
        if (revision !== renderVersion) return;
        current = {
            ...meta,
            ...revealed,
            key: editing
        };
        if (!view.provider) view.provider = current.provider;
    }
    if (!editing && !view.provider) return renderProviderPicker(project);
    const prov = providerById(view.provider);
    $app.appendChild(topbar({
        crumb: {
            label: editing ? project : "Services",
            onClick: () => {
                view = editing ? {
                    name: "project",
                    project: project
                } : {
                    name: "secret",
                    project: project,
                    secret: null,
                    provider: undefined
                };
                render();
            }
        }
    }));
    const scroll = el(`<div class="scroll"></div>`);
    scroll.appendChild(el(`<div class="section"><span class="label" style="display:flex;align-items:center;gap:7px">${prov.svg}${esc(prov.name)}</span><span class="label">${editing ? "Edit" : "New"}</span></div>`));
    if (prov.type === "password") buildPasswordForm(scroll, project, prov, editing, current); else if (prov.type === "custom") buildCustomForm(scroll, project, prov, editing, current); else buildKeysForm(scroll, project, prov, editing, current);
    $app.appendChild(scroll);
}

function fieldBlock(labelHtml) {
    return el(`<div class="field"><span class="label">${labelHtml}</span></div>`);
}

const OPTIONAL = ` <span class="optional">(optional)</span>`;

async function persist(project, payload, editing) {
    const key = payload.key.trim();
    if (editing && editing !== key) throw new Error("Key names cannot change during an edit; create a new entry instead");
    await window.vault.setSecret(project, {
        ...payload,
        key: key
    });
    if (editing && editing !== key) throw new Error("Create a separate key to rename an existing entry");
    view = {
        name: "project",
        project: project
    };
    render();
}

function accountFields(current) {
    const head = el(`<div class="field" style="margin-bottom:6px;margin-top:4px"><span class="label">Account login${OPTIONAL}</span></div>`);
    const box = el(`<div class="field acct-box"></div>`);
    const user = el(`<input type="text" placeholder="Username" value="${esc(current ? current.username : "")}" />`);
    const email = el(`<input type="text" placeholder="Email" value="${esc(current ? current.email : "")}" />`);
    const pass = el(`<input type="password" placeholder="Account password" value="${esc(current ? current.password : "")}" />`);
    const url = el(`<input type="text" placeholder="URL" value="${esc(current ? current.url : "")}" />`);
    [ user, email, pass, url ].forEach(n => box.appendChild(n));
    return {
        nodes: [ head, box ],
        get: () => ({
            username: user.value.trim(),
            email: email.value.trim(),
            password: pass.value,
            url: url.value.trim()
        })
    };
}

function metaFields(prov, current) {
    const permBlock = fieldBlock("Permission level" + OPTIONAL);
    const permGrid = el(`<div class="provider-grid"></div>`);
    const permInput = el(`<input type="text" placeholder="e.g. service_role (full)" value="${esc(current ? current.permission : "")}" style="margin-top:8px" />`);
    for (const lvl of prov.permissions || []) {
        const chip = el(`<div class="pchip"><span>${esc(lvl)}</span></div>`);
        chip.onclick = () => {
            permInput.value = lvl;
        };
        permGrid.appendChild(chip);
    }
    permBlock.appendChild(permGrid);
    permBlock.appendChild(permInput);
    const expBlock = fieldBlock("Expires" + OPTIONAL);
    const expGrid = el(`<div class="provider-grid"></div>`);
    const dateInput = el(`<input type="date" style="margin-top:8px;display:none" />`);
    let expiresAt = current && current.expiresAt ? current.expiresAt : "";
    const presets = [ [ "No expiry", 0 ], [ "24 hours", 1 ], [ "7 days", 7 ], [ "30 days", 30 ], [ "90 days", 90 ], [ "Custom…", -1 ] ];
    const setActive = label => [ ...expGrid.children ].forEach(c => c.classList.toggle("sel", c.dataset.label === label));
    for (const [label, days] of presets) {
        const chip = el(`<div class="pchip" data-label="${esc(label)}"><span>${esc(label)}</span></div>`);
        chip.onclick = () => {
            if (days === 0) {
                expiresAt = "";
                dateInput.style.display = "none";
            } else if (days === -1) {
                dateInput.style.display = "block";
                if (dateInput.value) expiresAt = new Date(dateInput.value + "T00:00:00").toISOString();
            } else {
                expiresAt = new Date(Date.now() + days * 864e5).toISOString();
                dateInput.style.display = "none";
            }
            setActive(label);
        };
        expGrid.appendChild(chip);
    }
    dateInput.addEventListener("change", () => {
        if (dateInput.value) expiresAt = new Date(dateInput.value + "T00:00:00").toISOString();
    });
    if (expiresAt) {
        dateInput.style.display = "block";
        dateInput.value = expiresAt.slice(0, 10);
        setActive("Custom…");
    } else setActive("No expiry");
    expBlock.appendChild(expGrid);
    expBlock.appendChild(dateInput);
    return {
        nodes: [ permBlock, expBlock ],
        get: () => ({
            permission: permInput.value.trim(),
            expiresAt: expiresAt
        })
    };
}

function buildKeysForm(scroll, project, prov, editing, current) {
    const whichField = fieldBlock("Which key");
    const opts = el(`<div class="provider-grid"></div>`);
    whichField.appendChild(opts);
    const keyField = fieldBlock('Key name <span class="optional">(the env variable)</span>');
    const keyInput = el(`<input type="text" placeholder="${esc(prov.fields[0] ? prov.fields[0].key : "API_KEY")}" value="${esc(current ? current.key : "")}" />`);
    keyField.appendChild(keyInput);
    function paintOpts() {
        opts.innerHTML = "";
        for (const f of prov.fields) {
            const chip = el(`<div class="pchip ${f.key === keyInput.value ? "sel" : ""}" title="${esc(f.key)}"><span>${esc(f.label)}</span></div>`);
            chip.onclick = () => {
                keyInput.value = f.key;
                paintOpts();
                valInput.focus();
            };
            opts.appendChild(chip);
        }
    }
    keyInput.addEventListener("input", paintOpts);
    const valField = fieldBlock("Value");
    const valInput = el(`<textarea placeholder="paste the value">${esc(current ? current.value : "")}</textarea>`);
    valField.appendChild(valInput);
    const noteField = fieldBlock("Note" + OPTIONAL);
    const noteInput = el(`<input type="text" placeholder="extra context" value="${esc(current ? current.note : "")}" />`);
    noteField.appendChild(noteInput);
    const meta = metaFields(prov, current);
    const acct = accountFields(current);
    const err = el(`<div class="err"></div>`);
    const save = el(`<button class="btn">Save key</button>`);
    save.onclick = () => {
        if (!keyInput.value.trim()) {
            err.textContent = "Pick a key or type its name.";
            return;
        }
        persist(project, {
            key: keyInput.value,
            value: valInput.value,
            provider: prov.id,
            note: noteInput.value.trim(),
            ...meta.get(),
            ...acct.get()
        }, editing);
    };
    [ whichField, keyField, valField, ...meta.nodes, noteField, ...acct.nodes, err, save ].forEach(n => scroll.appendChild(n));
    paintOpts();
}

function buildPasswordForm(scroll, project, prov, editing, current) {
    const labelField = fieldBlock("Label");
    const labelInput = el(`<input type="text" placeholder="e.g. Client X — WordPress admin" value="${esc(current ? current.key : "")}" />`);
    labelField.appendChild(labelInput);
    const userField = fieldBlock("Username" + OPTIONAL);
    const userInput = el(`<input type="text" placeholder="username" value="${esc(current ? current.username : "")}" />`);
    userField.appendChild(userInput);
    const emailField = fieldBlock("Email" + OPTIONAL);
    const emailInput = el(`<input type="text" placeholder="login@example.com" value="${esc(current ? current.email : "")}" />`);
    emailField.appendChild(emailInput);
    const passField = fieldBlock("Password");
    const passInput = el(`<input type="text" placeholder="the password" value="${esc(current ? current.value : "")}" />`);
    passField.appendChild(passInput);
    const urlField = fieldBlock("URL" + OPTIONAL);
    const urlInput = el(`<input type="text" placeholder="https://…" value="${esc(current ? current.url : "")}" />`);
    urlField.appendChild(urlInput);
    const noteField = fieldBlock("Note" + OPTIONAL);
    const noteInput = el(`<input type="text" placeholder="extra context" value="${esc(current ? current.note : "")}" />`);
    noteField.appendChild(noteInput);
    const err = el(`<div class="err"></div>`);
    const save = el(`<button class="btn">Save password</button>`);
    save.onclick = () => {
        if (!labelInput.value.trim()) {
            err.textContent = "Give it a label.";
            labelInput.focus();
            return;
        }
        if (!passInput.value) {
            err.textContent = "Password is empty.";
            passInput.focus();
            return;
        }
        persist(project, {
            key: labelInput.value,
            value: passInput.value,
            provider: "password",
            note: noteInput.value.trim(),
            username: userInput.value.trim(),
            email: emailInput.value.trim(),
            url: urlInput.value.trim()
        }, editing);
    };
    [ labelField, userField, emailField, passField, urlField, noteField, err, save ].forEach(n => scroll.appendChild(n));
    labelInput.focus();
}

function buildCustomForm(scroll, project, prov, editing, current) {
    const keyField = fieldBlock("Name");
    const keyInput = el(`<input type="text" placeholder="what is this?" value="${esc(current ? current.key : "")}" />`);
    keyField.appendChild(keyInput);
    const valField = fieldBlock("Value");
    const valInput = el(`<textarea placeholder="paste the value">${esc(current ? current.value : "")}</textarea>`);
    valField.appendChild(valInput);
    const noteField = fieldBlock("Note" + OPTIONAL);
    const noteInput = el(`<input type="text" placeholder="extra context" value="${esc(current ? current.note : "")}" />`);
    noteField.appendChild(noteInput);
    const meta = metaFields(prov, current);
    const acct = accountFields(current);
    const err = el(`<div class="err"></div>`);
    const save = el(`<button class="btn">Save</button>`);
    save.onclick = () => {
        if (!keyInput.value.trim()) {
            err.textContent = "Name is required.";
            keyInput.focus();
            return;
        }
        persist(project, {
            key: keyInput.value,
            value: valInput.value,
            provider: "custom",
            note: noteInput.value.trim(),
            ...meta.get(),
            ...acct.get()
        }, editing);
    };
    [ keyField, valField, ...meta.nodes, noteField, ...acct.nodes, err, save ].forEach(n => scroll.appendChild(n));
    keyInput.focus();
}

async function renderSettings() {
    const revision = renderVersion;
    $app.appendChild(topbar({
        crumb: {
            label: "Projects",
            onClick: () => {
                view = {
                    name: "projects"
                };
                render();
            }
        }
    }));
    const page = el(`<div class="scroll"></div>`);
    let scroll = page;
    page.appendChild(el(`<div class="section"><span class="label">Settings<span class="dot">.</span></span></div>`));
    const s = await window.vault.getSettings();
    if (revision !== renderVersion) return;
    scroll = panel(page, "Export password");
    const field = fieldBlock("Default export password");
    scroll.appendChild(field);
    const input = el(`<input type="password" placeholder="${s.hasExportPassword ? "Replace export password" : "Set export password"}" />`);
    field.appendChild(input);
    scroll.appendChild(el(`<div class="note">Encrypts exported PDFs, which contain secret values. Use a separate strong password and share exports only with trusted recipients.</div>`));
    scroll = panel(page, "Background access");
    const rememberLabel = el(`<label class="toggle"><input type="checkbox" class="switch" />Allow background access using macOS Keychain</label>`);
    const remember = rememberLabel.querySelector("input");
    remember.checked = s.rememberPassword;
    remember.disabled = !s.keyring.secure;
    scroll.appendChild(rememberLabel);
    scroll.appendChild(el(`<p class="note">Off by default. Enabling this lets the backend unlock without your password entry. Lock clears the saved password; unlock again to re-enable it. This does not isolate secrets from software running as you.</p>`));
    scroll = panel(page, "Locking");
    const softLabel = el(`<label class="toggle"><input type="checkbox" class="switch" />Soft lock: screen lock, sleep and idle lock only this window</label>`);
    const soft = softLabel.querySelector("input");
    soft.checked = s.lockPolicy === "soft";
    scroll.appendChild(softLabel);
    scroll.appendChild(el(`<p class="note">Off by default. With soft lock, the vault stays decrypted in memory and enrolled agents keep working while your Mac is locked, asleep or idle; anyone or anything that can act as your account in that time can use their grants. The Lock button always stops the API and clears the remembered password.</p>`));
    scroll = panel(page, "Sync");
    const autoLabel = el(`<label class="toggle"><input type="checkbox" class="switch" />Sync automatically while unlocked</label>`);
    const auto = autoLabel.querySelector("input");
    auto.checked = s.autoSync.enabled;
    scroll.appendChild(autoLabel);
    const intervalField = fieldBlock("Autosync interval (seconds)");
    const interval = el(`<input type="number" min="30" max="86400" step="1" />`);
    interval.value = String(s.autoSync.intervalSeconds);
    intervalField.appendChild(interval);
    scroll.appendChild(intervalField);
    scroll.appendChild(el(`<p class="note">Off by default. Uses Git sync configured on this device: pulls and pushes on this interval and a few seconds after each change. It stops and waits for you on conflicts or verification errors, and never accepts conflicts itself.</p>`));
    TOUCH_ID = (await window.vault.state()).touchId || TOUCH_ID;
    if (revision !== renderVersion) return;
    const t = s.touchId || {};
    // Shown where Touch ID can prompt, and wherever an option is still on so it can be turned off.
    const showTouchId = TOUCH_ID.available || t.unlock || t.humanActions || t.autoPrompt;
    if (showTouchId) scroll = panel(page, "Touch ID", {
        tag: TOUCH_ID.available ? "available" : "not available now"
    });
    const touchBox = (text, checked, needsRemember) => {
        const label = el(`<label class="toggle"><input type="checkbox" class="switch" /><span></span></label>`);
        label.querySelector("span").textContent = text;
        const box = label.querySelector("input");
        box.checked = checked;
        box.disabled = !checked && (!TOUCH_ID.available || needsRemember && !s.rememberPassword);
        if (showTouchId) scroll.appendChild(label);
        return box;
    };
    if (showTouchId) {
        scroll.appendChild(el(`<p class="note">Off by default. Needs background access above, because Touch ID unlock uses the password the Keychain remembers.</p>`));
    }
    const touchUnlock = touchBox("Unlock this window with Touch ID", t.unlock === true, true);
    const touchAuto = touchBox("Ask for Touch ID when the window opens", t.autoPrompt === true, true);
    const touchHuman = touchBox("Confirm reveal, copy, export, approvals, agent and security changes with Touch ID", t.humanActions === true, true);
    if (showTouchId) scroll.appendChild(el(`<p class="note">After Lock, the master password is required once. Confirmations cover the next 30 seconds; when Touch ID cannot be shown or is cancelled, the master password is asked instead. Touch ID guards this window only: anything running as your account can still use agent tokens and an unlocked API.</p>`));
    scroll = page;
    const err = el(`<div class="err"></div>`);
    const save = el(`<button class="btn">Save settings</button>`);
    save.onclick = async () => {
        try {
            await human("setSettings", {
                ...input.value ? {
                    exportPassword: input.value
                } : {},
                rememberPassword: remember.checked,
                lockPolicy: soft.checked ? "soft" : "hard",
                autoSync: {
                    enabled: auto.checked,
                    intervalSeconds: Number(interval.value)
                },
                ...showTouchId ? {
                    touchId: {
                        unlock: touchUnlock.checked,
                        autoPrompt: touchUnlock.checked && touchAuto.checked,
                        humanActions: touchHuman.checked
                    }
                } : {}
            });
        } catch (e) {
            err.textContent = cleanError(e);
            return;
        }
        err.textContent = "";
        save.textContent = "Saved ✓";
        save.classList.add("copied");
        setTimeout(() => {
            save.textContent = "Save settings";
            save.classList.remove("copied");
        }, 1500);
    };
    const saveRow = el(`<div class="saverow"></div>`);
    saveRow.appendChild(err);
    saveRow.appendChild(save);
    page.appendChild(saveRow);
    scroll = panel(page, "Master password");
    const k = s.keyring || {};
    const STORE_NAMES = {
        "macos-keychain": "macOS Keychain",
        unavailable: "Password remembering unavailable"
    };
    scroll.appendChild(el(`<div class="note">${esc(k.detail)} Background access is ${s.rememberPassword ? "enabled" : "disabled"}. No plaintext password file is used.</div>`));
    scroll.appendChild(el('<p class="note">Rotation changes this vault and attempts to re-encrypt local backups. External copies keep their old password. Keep both passwords until you verify the result.</p>'));
    const pwOld = el(`<input type="password" placeholder="Current password" />`);
    const pwNew = el(`<input type="password" placeholder="New password" />`);
    const pwNew2 = el(`<input type="password" placeholder="Confirm new password" />`);
    const pwErr = el(`<div class="err"></div>`);
    const pwOut = el(`<div class="val" style="display:none"></div>`);
    const pwBtn = el(`<button class="btn ghost">Change master password</button>`);
    pwBtn.onclick = async () => {
        pwErr.textContent = "";
        pwOut.style.display = "none";
        if (pwNew.value !== pwNew2.value) {
            pwErr.textContent = "The new passwords do not match.";
            return;
        }
        if ((pwNew.value || "").length < 12) {
            pwErr.textContent = "Use at least 12 characters.";
            return;
        }
        pwBtn.textContent = "Rotating…";
        try {
            const r = await human("changePassword", pwOld.value, pwNew.value);
            if (revision !== renderVersion) return;
            const done = r.backups.filter(b => b.status === "re-encrypted").length;
            const skipped = r.backups.filter(b => b.status !== "re-encrypted");
            const lines = [ "Rotated.", `  vault re-encrypted under the new password`, `  ${STORE_NAMES[r.keyring.store] || r.keyring.store}: ${r.keyring.updated ? "updated" : "not saved"}`, `  ${done} backup${done === 1 ? "" : "s"} re-encrypted` ];
            lines.push(...(r.warnings || []));
            for (const b of skipped) lines.push(`  ${b.file}: ${b.status}`);
            lines.push("", "The vault now uses your new password. External backup copies are unchanged.");
            pwOut.textContent = lines.join("\n");
            pwOut.style.display = "block";
            pwOld.value = pwNew.value = pwNew2.value = "";
        } catch (e) {
            pwErr.textContent = e.message;
        }
        pwBtn.textContent = "Change master password";
    };
    for (const n of [ pwOld, pwNew, pwNew2 ]) scroll.appendChild(n);
    scroll.appendChild(pwErr);
    scroll.appendChild(pwBtn);
    scroll.appendChild(pwOut);
    scroll = panel(page, "Agents, sync and history");
    const nav = el(`<div class="navrow"></div>`);
    const agentsBtn = el(`<button class="btn">Agents</button>`);
    agentsBtn.onclick = () => {
        view = {
            name: "agents"
        };
        render();
    };
    const syncBtn = el(`<button class="btn ghost">Sync</button>`);
    syncBtn.onclick = () => {
        view = {
            name: "sync"
        };
        render();
    };
    const historyBtn = el('<button class="btn ghost">History</button>');
    historyBtn.onclick = () => {
        view = {
            name: "history"
        };
        render();
    };
    nav.appendChild(agentsBtn);
    nav.appendChild(syncBtn);
    nav.appendChild(historyBtn);
    scroll.appendChild(nav);
    $app.appendChild(page);
}

async function renderAgents() {
    const revision = renderVersion;
    $app.appendChild(topbar({
        crumb: {
            label: "Settings",
            onClick: () => {
                view = {
                    name: "settings"
                };
                render();
            }
        }
    }));
    const scroll = el(`<div class="scroll"></div>`);
    scroll.appendChild(el(`<div class="section"><span class="label">Agents<span class="dot">.</span></span></div>`));
    scroll.appendChild(el(`<div class="note" style="margin:0 2px 14px">Any AI tool can be enrolled: Claude Code, Codex, Cursor, a script. Each gets its own token and its own scopes. Approve specific projects and folders. Agents can add keys only with the add scope; editing your keys also requires delegation and its matching scope.</div>`));
    const list = await window.vault.agents();
    if (revision !== renderVersion) return;
    const allScopes = await window.vault.allScopes();
    if (revision !== renderVersion) return;
    for (const a of list) {
        const card = el(`<div class="secret card">\n      <div class="head"><span class="key">${esc(a.name)}</span><span class="pname">${a.revoked ? "revoked" : "active"}</span></div>\n      <div class="badges">${a.scopes.map(x => `<span class="badge ${x === "reveal" ? "exp-amber" : "perm"}">${esc(x)}</span>`).join("")}${a.allProjects ? `<span class="badge allaccess">all projects</span>` : ""}${a.anyRoot ? `<span class="badge allaccess">any folder</span>` : ""}</div>\n      <div class="note">${esc(a.ref)} · enrolled ${esc((a.enrolledAt || "").slice(0, 10))}${a.lastSeenAt ? ` · last seen ${esc(a.lastSeenAt.slice(0, 16).replace("T", " "))}` : " · never used"}</div>\n      <div class="val" data-tok style="display:none"></div>\n      <div class="actions"></div></div>`);
        const actions = card.querySelector(".actions");
        const tok = card.querySelector("[data-tok]");
        const revealScope = el(`<button class="iconbtn">${a.scopes.includes("reveal") ? "Revoke reveal" : "Grant reveal"}</button>`);
        revealScope.onclick = async () => {
            const next = a.scopes.includes("reveal") ? a.scopes.filter(x => x !== "reveal") : [ ...a.scopes, "reveal" ];
            await human("setAgentScopes", a.id, next);
            render();
            if (revision !== renderVersion) return;
        };
        const reissue = el(`<button class="iconbtn" title="New token, same identity and same keys">Re-issue token</button>`);
        reissue.onclick = async () => {
            const r = await human("reissueAgent", a.id);
            if (revision !== renderVersion) return;
            tok.textContent = `New token (shown once):\n${r.token}\n\nPut it in the private (0600) token file named by VAULTOS_AGENT_TOKEN_FILE in your MCP configuration on the machine running this agent.`;
            tok.style.display = "block";
        };
        const revoke = el(`<button class="iconbtn danger">${a.revoked ? "Revoked" : "Revoke"}</button>`);
        revoke.disabled = a.revoked;
        let armed = false;
        revoke.onclick = async () => {
            if (!armed) {
                armed = true;
                revoke.textContent = "Confirm?";
                setTimeout(() => {
                    armed = false;
                    revoke.textContent = "Revoke";
                }, 2500);
                return;
            }
            await human("revokeAgent", a.id);
            render();
            if (revision !== renderVersion) return;
        };
        const accessBtn = el('<button class="iconbtn">Project & folder access</button>');
        accessBtn.onclick = async () => {
            accessBtn.disabled = true;
            const picker = await accessPicker(card, a);
            if (revision !== renderVersion) return;
            const saveAccess = el('<button class="btn sm">Save access</button>');
            card.appendChild(saveAccess);
            saveAccess.onclick = async () => {
                await human("setAgentAccess", a.id, picker.projects(), picker.roots, picker.wildcards());
                render();
            };
            if (revision !== renderVersion) return;
        };
        [ accessBtn, revealScope, reissue, revoke ].forEach(b => actions.appendChild(b));
        scroll.appendChild(card);
    }
    if (!list.length) scroll.appendChild(el(`<div class="empty"><div class="big">No agents</div><p>Nothing can write to this vault yet.</p></div>`));
    const enrol = panel(scroll, "Enrol a new agent");
    const field = fieldBlock("Enrol a new agent");
    const nameIn = el(`<input type="text" placeholder="claude-code, codex, cursor…" />`);
    field.appendChild(nameIn);
    enrol.appendChild(field);
    const scopeWrap = el(`<div class="badges" style="margin:0 2px 12px"></div>`);
    const chosen = new Set([ "read", "inject" ]);
    for (const sc of allScopes) {
        const b = el(`<button type="button" class="badge ${chosen.has(sc) ? "perm" : ""}">${esc(sc)}</button>`);
        b.onclick = () => {
            chosen.has(sc) ? chosen.delete(sc) : chosen.add(sc);
            b.className = `badge ${chosen.has(sc) ? "perm" : ""}`;
        };
        scopeWrap.appendChild(b);
    }
    enrol.appendChild(scopeWrap);
    enrol.appendChild(el(`<div class="note" style="margin:-4px 2px 12px">reveal is off by default. An agent without it can still write a working .env with inject, it just never sees a value.</div>`));
    const access = await accessPicker(enrol);
    if (revision !== renderVersion) return;
    const out = el(`<div class="val" style="display:none"></div>`);
    const err = el(`<div class="err"></div>`);
    const add = el(`<button class="btn">Enrol agent</button>`);
    add.onclick = async () => {
        err.textContent = "";
        try {
            const r = await human("enrolAgent", nameIn.value.trim(), [ ...chosen ], access.projects(), access.roots, access.wildcards());
            if (revision !== renderVersion) return;
            out.textContent = `${r.name} enrolled.\n\nToken (shown once):\n${r.token}\n\nPut it in the private (0600) token file named by VAULTOS_AGENT_TOKEN_FILE in your MCP configuration on that machine.`;
            out.style.display = "block";
            nameIn.value = "";
            await refreshAgents();
            if (revision !== renderVersion) return;
        } catch (e) {
            err.textContent = e.message;
        }
    };
    enrol.appendChild(err);
    enrol.appendChild(add);
    enrol.appendChild(out);
    $app.appendChild(scroll);
}

async function renderDelegate() {
    const revision = renderVersion;
    const {project: project, secret: secret} = view;
    $app.appendChild(topbar({
        crumb: {
            label: project,
            onClick: () => {
                view = {
                    name: "project",
                    project: project
                };
                render();
            }
        }
    }));
    const scroll = el(`<div class="scroll"></div>`);
    scroll.appendChild(el(`<div class="section"><span class="label">${esc(secret)}<span class="dot">.</span></span></div>`));
    scroll.appendChild(el(`<div class="note" style="margin:0 2px 14px">Delegating lets an agent rotate or update this key. It stays yours and stays here; you can take it back at any time.</div>`));
    const all = await window.vault.secrets(project);
    if (revision !== renderVersion) return;
    const s = all.find(x => x.key === secret) || {
        editableBy: []
    };
    const agents = await window.vault.agents();
    if (revision !== renderVersion) return;
    for (const a of agents.filter(x => !x.revoked)) {
        const on = (s.editableBy || []).includes(a.ref);
        const row = el(`<div class="secret card"><div class="head"><span class="key">${esc(a.name)}</span><span class="pname">${on ? "may edit this key" : "read only"}</span></div><div class="actions"></div></div>`);
        const btn = el(`<button class="iconbtn ${on ? "danger" : ""}">${on ? "Remove" : "Delegate"}</button>`);
        btn.onclick = async () => {
            await human("delegate", project, secret, a.ref, !on);
            render();
        };
        if (revision !== renderVersion) return;
        row.querySelector(".actions").appendChild(btn);
        scroll.appendChild(row);
    }
    if (!agents.length) scroll.appendChild(el(`<div class="empty"><div class="big">No agents</div><p>Enrol one in Settings first.</p></div>`));
    $app.appendChild(scroll);
}

const SYNC_STATES = {
    IN_SYNC: {
        label: "In sync",
        tone: "ok",
        say: "Both machines hold the same records, and everything here has reached the remote."
    },
    RECORDS_OUT_OF_SYNC: {
        label: "Records differ",
        tone: "warn",
        say: "Commits match but the vaults differ. Pull, or push."
    },
    LOCAL_SYNC_REPO_DIRTY: {
        label: "Not sent",
        tone: "bad",
        say: "Records were written but never committed, so they have NOT left this machine. Press Push."
    },
    UNPUSHED_COMMITS: {
        label: "Not sent",
        tone: "bad",
        say: "Committed locally but never pushed. The other machine cannot see these. Press Push."
    },
    PEER_STALLED: {
        label: "Another machine is stuck",
        tone: "bad",
        say: "This machine is fine. Another one is sitting on records it never sent."
    },
    BEHIND_REMOTE: {
        label: "Behind",
        tone: "warn",
        say: "The other machine has newer records. Press Pull."
    },
    REMOTE_UNREACHABLE: {
        label: "Cannot reach the other machine",
        tone: "bad",
        say: "Sync state is UNKNOWN. This is not the same as being in sync."
    },
    GIT_HISTORY_DIVERGED: {
        label: "Diverged",
        tone: "bad",
        say: "Both sides committed independently. This needs resolving by hand before anything syncs."
    },
    SIGNATURE_INVALID: {
        label: "Signature problem",
        tone: "bad",
        say: "A sync manifest failed verification, or a rollback was detected. Refusing to merge."
    },
    UNREADABLE_RECORDS: {
        label: "Unreadable records",
        tone: "bad",
        say: "Some record files will not decrypt with this machine's key."
    },
    NO_GIT_REPO: {
        label: "No transport",
        tone: "bad",
        say: "The sync folder is not a git repo, so records go nowhere."
    },
    ERROR: {
        label: "Error",
        tone: "bad",
        say: ""
    }
};

const TONE = {
    ok: "perm",
    warn: "exp-amber",
    bad: "exp-red"
};

async function renderSync() {
    const revision = renderVersion;
    $app.appendChild(topbar({
        crumb: {
            label: "Settings",
            onClick: () => {
                view = {
                    name: "settings"
                };
                render();
            }
        }
    }));
    const scroll = el('<div class="scroll"><h2>Encrypted sync</h2><p class="note">Optional. Uses your dedicated Git repository and age. Follow docs/SYNC.md to configure transport and verify each peer identity through a trusted channel.</p></div>');
    $app.appendChild(scroll);
    const output = el('<pre class="val" style="white-space:pre-wrap"></pre>');
    const run = async fn => {
        try {
            const result = await fn();
            if (revision === renderVersion) output.textContent = JSON.stringify(result, null, 2);
        } catch (e) {
            if (revision === renderVersion) output.textContent = e.message;
        }
    };
    const label = el('<input placeholder="Machine label (public in sync repository)" />');
    const init = el('<button class="btn ghost">Initialize preview sync</button>');
    init.onclick = () => run(() => window.vault.syncInit(label.value));
    const identity = el('<button class="btn ghost">Show public identity</button>');
    identity.onclick = () => run(() => window.vault.syncIdentity());
    const peer = el('<textarea placeholder="Paste verified peer identity JSON" rows="6"></textarea>');
    const trust = el('<button class="btn ghost">Trust verified peer</button>');
    trust.onclick = () => run(() => human("syncTrust", JSON.parse(peer.value)));
    const status = el('<button class="btn ghost">Check remote status and conflicts</button>');
    status.onclick = () => run(() => window.vault.syncStatus());
    const push = el('<button class="btn">Push to Git remote</button>');
    push.onclick = () => run(() => window.vault.syncPush());
    const pull = el('<button class="btn">Pull from Git remote</button>');
    pull.onclick = () => run(() => window.vault.syncPull(false));
    const accept = el('<button class="btn ghost">Pull and accept listed conflict winners</button>');
    accept.onclick = () => run(() => window.vault.syncPull(true));
    const group = title => {
        const body = panel(scroll, title);
        body.classList.add("stack");
        return body;
    };
    const thisMachine = group("This machine");
    for (const n of [ label, init, identity ]) thisMachine.appendChild(n);
    const peers = group("Peers");
    for (const n of [ peer, trust ]) peers.appendChild(n);
    const records = group("Move records");
    for (const n of [ status, push, pull, accept, el('<p class="note">A remote receipt confirms Git accepted a commit. Other devices must still pull it. Review conflicts before accepting; an encrypted local backup is created before a merge.</p>') ]) records.appendChild(n);
    scroll.appendChild(output);
}

async function renderHistory() {
    const revision = renderVersion;
    $app.appendChild(topbar({
        crumb: {
            label: "Settings",
            onClick: () => {
                view = {
                    name: "settings"
                };
                render();
            }
        }
    }));
    const entries = await window.vault.history(100);
    if (revision !== renderVersion) return;
    const scroll = el('<div class="scroll"><h2>Recent changes</h2><p class="note">Undo refuses to overwrite a newer edit. Secret values are omitted from this view.</p></div>');
    if (!entries.length) scroll.appendChild(el(`<div class="empty"><div class="big">No changes yet</div><p>Edits to projects and keys will show up here.</p></div>`));
    for (const entry of entries) {
        const row = el(`<div class="secret card"><div class="key">${esc(entry.action)} ${esc(entry.key || "")}</div><p class="note">${esc(entry.ts)} · ${esc(agentLabel(entry.actor))}</p></div>`);
        if (!entry.reverted && [ "create_secret", "update_secret", "delete_secret", "create_project", "delete_project" ].includes(entry.action)) {
            const undo = el('<button class="btn ghost sm">Undo</button>');
            undo.onclick = async () => {
                await window.vault.revert(entry.id);
                render();
            };
            row.appendChild(undo);
        }
        scroll.appendChild(row);
    }
    $app.appendChild(scroll);
}

boot();

async function accessPicker(parent, current = {}) {
    const chosen = new Set(current.projects || []), roots = [ ...current.roots || [] ];
    const wrap = el('<div class="field"><span class="label">Approved projects</span></div>');
    const wildcard = (label, warning, checked) => {
        const row = el(`<label class="toggle tight"><input type="checkbox" class="chk" />${esc(label)}</label>`);
        const note = el(`<div class="warn-note" style="display:none">${esc(warning)}</div>`);
        const box = row.querySelector("input");
        box.checked = checked;
        note.style.display = checked ? "block" : "none";
        box.addEventListener("change", () => {
            note.style.display = box.checked ? "block" : "none";
        });
        wrap.appendChild(row);
        wrap.appendChild(note);
        return box;
    };
    const allBox = wildcard("All projects, including future ones", "All access: this agent can use every project in the vault, including projects created later, within its scopes. Prefer choosing projects.", current.allProjects === true);
    const projectBoxes = [];
    for (const project of await window.vault.projects()) {
        const row = el(`<label class="toggle tight"><input type="checkbox" class="chk" />${esc(project.name)}</label>`);
        const box = row.querySelector("input");
        box.checked = chosen.has(project.id);
        box.onchange = () => box.checked ? chosen.add(project.id) : chosen.delete(project.id);
        projectBoxes.push(box);
        wrap.appendChild(row);
    }
    const syncProjects = () => projectBoxes.forEach(box => {
        box.disabled = allBox.checked;
    });
    allBox.addEventListener("change", syncProjects);
    syncProjects();
    const folderList = el('<div class="note"></div>');
    const draw = () => {
        folderList.replaceChildren();
        for (const folder of [ ...roots ]) {
            const row = el(`<div class="folder-row"><span>${esc(folder)}</span> <button class="iconbtn">Remove</button></div>`);
            row.querySelector("button").onclick = () => {
                roots.splice(roots.indexOf(folder), 1);
                draw();
            };
            folderList.appendChild(row);
        }
    };
    draw();
    const add = el('<button class="btn ghost sm">Approve a project folder…</button>');
    add.onclick = async () => {
        const folder = await window.vault.chooseFolder();
        if (folder && !roots.includes(folder)) {
            roots.push(folder);
            draw();
        }
    };
    wrap.appendChild(folderList);
    wrap.appendChild(add);
    const anyBox = wildcard("Any folder", "All access: this agent can read .env files from and write secrets to any path your account can write, except the vault's own folder. Prefer approving project folders.", current.anyRoot === true);
    parent.appendChild(wrap);
    return {
        projects: () => [ ...chosen ],
        roots: roots,
        wildcards: () => ({
            allProjects: allBox.checked,
            anyRoot: anyBox.checked
        })
    };
}

window.addEventListener("focus", async () => {
    if (view.name !== "unlock") return;
    const t = (await window.vault.state()).touchId;
    if (t && view.name === "unlock" && (t.ready !== TOUCH_ID.ready || t.enabled !== TOUCH_ID.enabled)) render();
});

window.vault.onLocked(() => {
    AGENTS = [];
    view = {
        name: "unlock"
    };
    render();
});

window.addEventListener("unhandledrejection", event => {
    event.preventDefault();
    const message = String(event.reason?.message || "The operation failed. Please retry.");
    if (message.includes("Vault is locked")) {
        view = {
            name: "unlock"
        };
        render();
        return;
    }
    let notice = document.querySelector("#error-notice");
    if (!notice) {
        notice = el('<div id="error-notice" class="err" role="alert" style="padding:12px"></div>');
        $app.prepend(notice);
    }
    notice.textContent = message;
});

new MutationObserver(() => {
    for (const input of document.querySelectorAll("input:not([aria-label]),textarea:not([aria-label]),select:not([aria-label])")) if (!input.closest("label")) input.setAttribute("aria-label", input.closest(".field")?.querySelector(".label")?.textContent || input.placeholder || input.type);
    for (const row of document.querySelectorAll(".row:not([tabindex]),.pcard:not([tabindex]),.crumb:not([tabindex])")) {
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.onkeydown = e => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                row.click();
            }
        };
    }
}).observe($app, {
    childList: true,
    subtree: true
});
