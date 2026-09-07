import { mkdirSync } from "node:fs";

import { execFileSync } from "node:child_process";

if (process.platform !== "darwin") throw new Error("The Keychain helper must be built on macOS");

mkdirSync("build/native", {
    recursive: true
});

const arch = process.env.VAULTOS_ARCH || (process.arch === "arm64" ? "arm64" : "x86_64");

execFileSync("/usr/bin/swiftc", [ "-O", "-target", `${arch}-apple-macos13.0`, "native/Keychain.swift", "-o", "build/native/vaultos-keychain" ], {
    stdio: "inherit"
});

if (process.env.VAULTOS_BUILD_TEST_HELPER === "1") execFileSync("/usr/bin/swiftc", [ "-O", "-D", "VAULTOS_TEST", "native/Keychain.swift", "-o", "build/native/vaultos-keychain-test" ], {
    stdio: "inherit"
});
