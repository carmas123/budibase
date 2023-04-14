"use strict";
const crypto = require("crypto");
const env = require("../environment");
const ALGO = "aes-256-ctr";
const SECRET = env.JWT_SECRET;
const SEPARATOR = "-";
const ITERATIONS = 10000;
const RANDOM_BYTES = 16;
const STRETCH_LENGTH = 32;
function stretchString(string, salt) {
    return crypto.pbkdf2Sync(string, salt, ITERATIONS, STRETCH_LENGTH, "sha512");
}
exports.encrypt = input => {
    const salt = crypto.randomBytes(RANDOM_BYTES);
    const stretched = stretchString(SECRET, salt);
    const cipher = crypto.createCipheriv(ALGO, stretched, salt);
    const base = cipher.update(input);
    const final = cipher.final();
    const encrypted = Buffer.concat([base, final]).toString("hex");
    return `${salt.toString("hex")}${SEPARATOR}${encrypted}`;
};
exports.decrypt = input => {
    const [salt, encrypted] = input.split(SEPARATOR);
    const saltBuffer = Buffer.from(salt, "hex");
    const stretched = stretchString(SECRET, saltBuffer);
    const decipher = crypto.createDecipheriv(ALGO, stretched, saltBuffer);
    const base = decipher.update(Buffer.from(encrypted, "hex"));
    const final = decipher.final();
    return Buffer.concat([base, final]).toString();
};
//# sourceMappingURL=encryption.js.map