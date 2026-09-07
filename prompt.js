"use strict";

async function passwordPrompt(message = "Master password: ") {
    if (process.argv.includes("--password-stdin")) {
        let input = "";
        for await (const chunk of process.stdin) {
            input += chunk;
            if (input.length > 4096) throw new Error("Password input too long");
        }
        return input.replace(/\r?\n$/, "");
    }
    if (!process.stdin.isTTY) throw new Error("Use an interactive terminal or --password-stdin");
    process.stderr.write(message);
    return new Promise((resolve, reject) => {
        let value = "";
        const input = process.stdin;
        input.setRawMode(true);
        input.resume();
        input.setEncoding("utf8");
        const stop = () => {
            input.setRawMode(false);
            input.pause();
            input.off("data", read);
            process.stderr.write("\n");
        };
        function read(data) {
            for (const c of data) {
                if (c === "") {
                    stop();
                    reject(new Error("Cancelled"));
                    return;
                }
                if (c === "\r" || c === "\n") {
                    stop();
                    resolve(value);
                    return;
                }
                if (c === "") {
                    value = value.slice(0, -1);
                } else if (c >= " " && value.length < 1024) value += c;
            }
        }
        input.on("data", read);
    });
}

module.exports = {
    passwordPrompt: passwordPrompt
};
