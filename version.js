"use strict";

const M = require("./model");

module.exports = {
    deployment: () => ({
        version: require("./package.json").version,
        formatVersion: M.FORMAT_VERSION,
        minReaderVersion: M.MIN_READER_VERSION
    })
};
