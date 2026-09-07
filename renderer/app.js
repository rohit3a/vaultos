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

const agentLabel = ref => {
    const a = AGENTS.find(x => x.ref === ref);
    return a ? a.name : (ref || "").replace(/^agent:/, "agent ");
};

const LOCK_GLYPH = `<svg class="glyph" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">\n  <rect x="10" y="24" width="36" height="26" rx="7" fill="#ea4711" opacity="0.14"/>\n  <rect x="10" y="24" width="36" height="26" rx="7" stroke="#ea4711" stroke-width="2.5"/>\n  <path d="M18 24v-6a10 10 0 0 1 20 0v6" stroke="#ea4711" stroke-width="2.5" stroke-linecap="round"/>\n  <circle cx="28" cy="35" r="3.5" fill="#ea4711"/>\n  <rect x="26.5" y="35" width="3" height="8" rx="1.5" fill="#ea4711"/>\n</svg>`;

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
    view = s.exists ? {
        name: "unlock"
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
    bar.appendChild(el(`<div class="wordmark">VAULT<span class="dot">.</span>OS</div>`));
    bar.appendChild(el(`<div class="status"><span class="led"></span>Unlocked</div>`));
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
    wrap.appendChild(el(LOCK_GLYPH));
    wrap.appendChild(el(`<h1>Set up your vault</h1>`));
    wrap.appendChild(el(`<p>One master password encrypts everything. It stays in memory while unlocked. Optional Keychain access can be enabled later. Keep the password safe; there is no password reset.</p>`));
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

function renderUnlock() {
    const wrap = el(`<div class="center"></div>`);
    wrap.appendChild(el(LOCK_GLYPH));
    wrap.appendChild(el(`<h1>VAULT<span class="dot" style="color:var(--orange)">.</span>OS</h1>`));
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
    $app.appendChild(wrap);
    pw.focus();
}

async function renderProjects() {
    const revision = renderVersion;
    $app.appendChild(topbar());
    const scroll = el(`<div class="scroll"></div>`);
    const projects = await window.vault.projects();
    if (revision !== renderVersion) return;
    await refreshAgents();
    if (revision !== renderVersion) return;
    scroll.appendChild(el(`<div class="section"><span class="label">Projects<span class="dot" style="color:var(--orange)">.</span></span><span class="label">${projects.length}</span></div>`));
    const pending = await window.vault.pending();
    if (revision !== renderVersion) return;
    if (pending.length) {
        const banner = el(`<div class="secret" style="border-color:var(--orange)">\n      <div class="head"><span class="key">${pending.length} key${pending.length === 1 ? "" : "s"} awaiting your approval</span></div>\n      <div class="note">Added by an agent. Held back from .env until you approve.</div>\n      <div class="actions"></div></div>`);
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
        scroll.appendChild(el(`<div class="empty"><div class="big">No projects yet</div>Create one, then stash its API keys.</div>`));
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
    const actionRow = el(`<div style="display:flex;gap:8px;margin-bottom:14px"></div>`);
    const add = el(`<button class="btn"><span style="font-size:15px">+</span> Add key</button>`);
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
        const r = await window.vault.exportProject(project);
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
    if (!secrets.length) scroll.appendChild(el(`<div class="empty"><div class="big">Empty</div>No keys stored here yet.</div>`));
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
        const card = el(`<div class="secret">\n      <div class="head">${prov.svg}<span class="key">${esc(s.key)}</span><span class="pname">${esc(prov.name)}</span></div>\n      ${badges.length ? `<div class="badges">${badges.join("")}</div>` : ""}\n      ${sub ? `<div class="note">${sub}</div>` : ""}\n      ${s.note ? `<div class="note">${esc(s.note)}</div>` : ""}\n      <div class="val" data-val style="display:none"></div>\n      <div class="actions"></div></div>`);
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
            const r = await window.vault.reveal(project, s.key);
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
            await window.vault.copy(project, s.key);
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
                await window.vault.approveInject(project, s.key, true);
                render();
            };
            if (revision !== renderVersion) return;
            ownActions.push(okBtn);
        }
        if (s.owner && s.owner !== "human") {
            const adoptBtn = el(`<button class="iconbtn" title="Take ownership; the agent can no longer change it">Adopt</button>`);
            adoptBtn.onclick = async () => {
                await window.vault.adopt(project, s.key);
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
    scroll.appendChild(el(`<div class="section"><span class="label">Add to ${esc(project)}<span class="dot" style="color:var(--orange)">.</span></span></div>`));
    scroll.appendChild(el(`<div class="label" style="margin:0 2px 10px;color:var(--white-45)">Which service is this for?</div>`));
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
        const revealed = await window.vault.reveal(project, editing);
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

const OPTIONAL = ` <span style="text-transform:none;letter-spacing:0;color:var(--white-30)">(optional)</span>`;

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
    const keyField = fieldBlock('Key name <span style="text-transform:none;letter-spacing:0;color:var(--white-30)">(the env variable)</span>');
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
    const scroll = el(`<div class="scroll"></div>`);
    scroll.appendChild(el(`<div class="section"><span class="label">Settings<span class="dot" style="color:var(--orange)">.</span></span></div>`));
    const s = await window.vault.getSettings();
    if (revision !== renderVersion) return;
    const field = fieldBlock("Default export password");
    scroll.appendChild(field);
    scroll.appendChild(el(`<div class="note" style="margin:-8px 2px 10px;color:var(--white-45)">Encrypts exported PDFs, which contain secret values. Use a separate strong password and share exports only with trusted recipients.</div>`));
    const input = el(`<input type="password" placeholder="${s.hasExportPassword ? "Replace export password" : "Set export password"}" />`);
    field.appendChild(input);
    const rememberLabel = el(`<label class="note" style="display:flex;gap:10px;margin:16px 0"><input type="checkbox" style="width:auto" />Allow background access using macOS Keychain</label>`);
    const remember = rememberLabel.querySelector("input");
    remember.checked = s.rememberPassword;
    remember.disabled = !s.keyring.secure;
    scroll.appendChild(rememberLabel);
    scroll.appendChild(el(`<p class="note">Off by default. Enabling this lets the backend unlock without your password entry. Lock clears the saved password; unlock again to re-enable it. This does not isolate secrets from software running as you.</p>`));
    const err = el(`<div class="err"></div>`);
    const save = el(`<button class="btn">Save settings</button>`);
    save.onclick = async () => {
        try {
            await window.vault.setSettings({
                ...input.value ? {
                    exportPassword: input.value
                } : {},
                rememberPassword: remember.checked
            });
        } catch (e) {
            err.textContent = e.message;
            return;
        }
        save.textContent = "Saved ✓";
        save.classList.add("copied");
        setTimeout(() => {
            save.textContent = "Save settings";
            save.classList.remove("copied");
        }, 1500);
    };
    scroll.appendChild(err);
    scroll.appendChild(save);
    scroll.appendChild(el(`<div class="section" style="margin-top:26px"><span class="label">Master password</span></div>`));
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
            const r = await window.vault.changePassword(pwOld.value, pwNew.value);
            if (revision !== renderVersion) return;
            const done = r.backups.filter(b => b.status === "re-encrypted").length;
            const skipped = r.backups.filter(b => b.status !== "re-encrypted");
            const lines = [ "Rotated.", `  vault re-encrypted under the new password`, `  ${STORE_NAMES[r.keyring.store] || r.keyring.store} entry updated`, `  ${done} backup${done === 1 ? "" : "s"} re-encrypted` ];
            for (const b of skipped) lines.push(`  ${b.file}: ${b.status} — delete it yourself`);
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
    scroll.appendChild(el(`<div class="section" style="margin-top:26px"><span class="label">Access</span></div>`));
    const nav = el(`<div style="display:flex;gap:8px"></div>`);
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
    $app.appendChild(scroll);
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
    scroll.appendChild(el(`<div class="section"><span class="label">Agents<span class="dot" style="color:var(--orange)">.</span></span></div>`));
    scroll.appendChild(el(`<div class="note" style="margin:0 2px 12px;color:var(--white-45)">Any AI tool can be enrolled: Claude Code, Codex, Cursor, a script. Each gets its own token and its own scopes. Approve specific projects and folders. Agents can add keys only with the add scope; editing your keys also requires delegation and its matching scope.</div>`));
    const list = await window.vault.agents();
    if (revision !== renderVersion) return;
    const allScopes = await window.vault.allScopes();
    if (revision !== renderVersion) return;
    for (const a of list) {
        const card = el(`<div class="secret">\n      <div class="head"><span class="key">${esc(a.name)}</span><span class="pname">${a.revoked ? "revoked" : "active"}</span></div>\n      <div class="badges">${a.scopes.map(x => `<span class="badge perm">${esc(x)}</span>`).join("")}</div>\n      <div class="note">${esc(a.ref)} · enrolled ${esc((a.enrolledAt || "").slice(0, 10))}${a.lastSeenAt ? ` · last seen ${esc(a.lastSeenAt.slice(0, 16).replace("T", " "))}` : " · never used"}</div>\n      <div class="val" data-tok style="display:none"></div>\n      <div class="actions"></div></div>`);
        const actions = card.querySelector(".actions");
        const tok = card.querySelector("[data-tok]");
        const revealScope = el(`<button class="iconbtn">${a.scopes.includes("reveal") ? "Revoke reveal" : "Grant reveal"}</button>`);
        revealScope.onclick = async () => {
            const next = a.scopes.includes("reveal") ? a.scopes.filter(x => x !== "reveal") : [ ...a.scopes, "reveal" ];
            await window.vault.setAgentScopes(a.id, next);
            render();
            if (revision !== renderVersion) return;
        };
        const reissue = el(`<button class="iconbtn" title="New token, same identity and same keys">Re-issue token</button>`);
        reissue.onclick = async () => {
            const r = await window.vault.reissueAgent(a.id);
            if (revision !== renderVersion) return;
            tok.textContent = `New token (shown once):\n${r.token}\n\nPut it in the token file named in your MCP configuration on the machine running this agent, or set VAULT_AGENT_TOKEN.`;
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
            await window.vault.revokeAgent(a.id);
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
                await window.vault.setAgentAccess(a.id, picker.projects(), picker.roots);
                render();
            };
            if (revision !== renderVersion) return;
        };
        [ accessBtn, revealScope, reissue, revoke ].forEach(b => actions.appendChild(b));
        scroll.appendChild(card);
    }
    if (!list.length) scroll.appendChild(el(`<div class="empty"><div class="big">No agents</div>Nothing can write to this vault yet.</div>`));
    const field = fieldBlock("Enrol a new agent");
    const nameIn = el(`<input type="text" placeholder="claude-code, codex, cursor…" />`);
    field.appendChild(nameIn);
    scroll.appendChild(field);
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
    scroll.appendChild(scopeWrap);
    scroll.appendChild(el(`<div class="note" style="margin:-6px 2px 10px;color:var(--white-45)">reveal is off by default. An agent without it can still write a working .env with inject, it just never sees a value.</div>`));
    const access = await accessPicker(scroll);
    if (revision !== renderVersion) return;
    const out = el(`<div class="val" style="display:none"></div>`);
    const err = el(`<div class="err"></div>`);
    const add = el(`<button class="btn">Enrol agent</button>`);
    add.onclick = async () => {
        err.textContent = "";
        try {
            const r = await window.vault.enrolAgent(nameIn.value.trim(), [ ...chosen ], access.projects(), access.roots);
            if (revision !== renderVersion) return;
            out.textContent = `${r.name} enrolled.\n\nToken (shown once):\n${r.token}\n\nPut it in the token file named in your MCP configuration on that machine, or set VAULT_AGENT_TOKEN.`;
            out.style.display = "block";
            nameIn.value = "";
            await refreshAgents();
            if (revision !== renderVersion) return;
        } catch (e) {
            err.textContent = e.message;
        }
    };
    scroll.appendChild(err);
    scroll.appendChild(add);
    scroll.appendChild(out);
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
    scroll.appendChild(el(`<div class="section"><span class="label">${esc(secret)}<span class="dot" style="color:var(--orange)">.</span></span></div>`));
    scroll.appendChild(el(`<div class="note" style="margin:0 2px 14px;color:var(--white-45)">Delegating lets an agent rotate or update this key. It stays yours and stays here; you can take it back at any time.</div>`));
    const all = await window.vault.secrets(project);
    if (revision !== renderVersion) return;
    const s = all.find(x => x.key === secret) || {
        editableBy: []
    };
    const agents = await window.vault.agents();
    if (revision !== renderVersion) return;
    for (const a of agents.filter(x => !x.revoked)) {
        const on = (s.editableBy || []).includes(a.ref);
        const row = el(`<div class="secret"><div class="head"><span class="key">${esc(a.name)}</span><span class="pname">${on ? "may edit this key" : "read only"}</span></div><div class="actions"></div></div>`);
        const btn = el(`<button class="iconbtn ${on ? "danger" : ""}">${on ? "Remove" : "Delegate"}</button>`);
        btn.onclick = async () => {
            await window.vault.delegate(project, secret, a.ref, !on);
            render();
        };
        if (revision !== renderVersion) return;
        row.querySelector(".actions").appendChild(btn);
        scroll.appendChild(row);
    }
    if (!agents.length) scroll.appendChild(el(`<div class="empty"><div class="big">No agents</div>Enrol one in Settings first.</div>`));
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
    trust.onclick = () => run(() => window.vault.syncTrust(JSON.parse(peer.value)));
    const status = el('<button class="btn ghost">Check remote status and conflicts</button>');
    status.onclick = () => run(() => window.vault.syncStatus());
    const push = el('<button class="btn">Push to Git remote</button>');
    push.onclick = () => run(() => window.vault.syncPush());
    const pull = el('<button class="btn">Pull from Git remote</button>');
    pull.onclick = () => run(() => window.vault.syncPull(false));
    const accept = el('<button class="btn ghost">Pull and accept listed conflict winners</button>');
    accept.onclick = () => run(() => window.vault.syncPull(true));
    for (const n of [ label, init, identity, peer, trust, status, push, pull, accept, el('<p class="note">A remote receipt confirms Git accepted a commit. Other devices must still pull it. Review conflicts before accepting; an encrypted local backup is created before a merge.</p>'), output ]) scroll.appendChild(n);
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
    for (const entry of entries) {
        const row = el(`<div class="secret"><div class="key">${esc(entry.action)} ${esc(entry.key || "")}</div><p class="note">${esc(entry.ts)} · ${esc(agentLabel(entry.actor))}</p></div>`);
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
    for (const project of await window.vault.projects()) {
        const row = el(`<label class="note" style="display:flex;gap:8px;padding:6px"><input type="checkbox" style="width:auto" />${esc(project.name)}</label>`);
        const box = row.querySelector("input");
        box.checked = chosen.has(project.id);
        box.onchange = () => box.checked ? chosen.add(project.id) : chosen.delete(project.id);
        wrap.appendChild(row);
    }
    const folderList = el('<div class="note"></div>');
    const draw = () => {
        folderList.replaceChildren();
        for (const folder of [ ...roots ]) {
            const row = el(`<div>${esc(folder)} <button class="iconbtn">Remove</button></div>`);
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
    parent.appendChild(wrap);
    return {
        projects: () => [ ...chosen ],
        roots: roots
    };
}

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
    for (const input of document.querySelectorAll("input:not([aria-label]),textarea:not([aria-label]),select:not([aria-label])")) input.setAttribute("aria-label", input.closest(".field")?.querySelector(".label")?.textContent || input.placeholder || input.type);
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
