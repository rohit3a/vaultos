"use strict";

const PDFDocument = require("pdfkit");

const fs = require("node:fs");

const {BY_ID: BY_ID} = require("./providers");

const ORANGE = "#ea4711";

const DARK = "#1a1a1a";

const GREY = "#777777";

const HAIR = "#dddddd";

async function exportProjectPdf({project: project, entries: entries}, outPath, password, generatedAt) {
    const doc = new PDFDocument({
        size: "A4",
        margin: 50,
        userPassword: password,
        ownerPassword: password,
        pdfVersion: "1.7ext3",
        permissions: {
            printing: "highResolution",
            copying: true
        },
        info: {
            Title: `${project} — Vault OS export`
        }
    });
    require("./validation").password(password);
    require("./fs-safe").regularFile(outPath, {
        optional: true
    });
    const tmp = outPath + "." + require("node:crypto").randomBytes(12).toString("hex");
    const stream = fs.createWriteStream(tmp, {
        mode: 384,
        flags: "wx"
    });
    const completed = new Promise((resolve, reject) => {
        stream.on("finish", resolve);
        stream.on("error", reject);
        doc.on("error", reject);
    });
    doc.pipe(stream);
    doc.font("Helvetica-Bold").fontSize(22).fillColor(DARK).text(project);
    doc.font("Helvetica").fontSize(10).fillColor(GREY).text(`Vault OS export · ${generatedAt}`);
    doc.moveDown(.4);
    doc.strokeColor(ORANGE).lineWidth(2).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1);
    const line = (label, val) => {
        if (!val) return;
        doc.font("Helvetica-Bold").fontSize(9).fillColor(GREY).text(label + ":", {
            continued: true
        });
        doc.font("Helvetica").fontSize(9.5).fillColor(DARK).text("  " + val);
    };
    if (!entries.length) doc.fillColor(GREY).text("No entries in this project.");
    for (const e of entries) {
        const prov = BY_ID[e.provider] || BY_ID.custom;
        if (doc.y > 740) doc.addPage();
        doc.font("Helvetica-Bold").fontSize(13).fillColor(DARK).text(e.key);
        doc.font("Helvetica-Bold").fontSize(8).fillColor(ORANGE).text((prov.name || "Custom").toUpperCase());
        doc.moveDown(.25);
        if (prov.type === "password") line("Password", e.value); else line("Value", e.value);
        line("Permission", e.permission);
        if (e.expiresAt) line("Expires", new Date(e.expiresAt).toLocaleDateString());
        line("Username", e.username);
        line("Email", e.email);
        if (prov.type !== "password") line("Account password", e.password);
        line("URL", e.url);
        line("Note", e.note);
        doc.moveDown(.5);
        doc.strokeColor(HAIR).lineWidth(.5).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(.6);
    }
    doc.end();
    try {
        await completed;
        require("./fs-safe").regularFile(outPath, {
            optional: true
        });
        fs.renameSync(tmp, outPath);
    } catch (e) {
        stream.destroy();
        try {
            fs.unlinkSync(tmp);
        } catch {}
        throw e;
    }
    return outPath;
}

module.exports = {
    exportProjectPdf: exportProjectPdf
};
