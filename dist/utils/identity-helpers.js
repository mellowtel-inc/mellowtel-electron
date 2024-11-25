"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrGenerateIdentifier = getOrGenerateIdentifier;
exports.getIdentifier = getIdentifier;
const storage_helpers_1 = require("../storage/storage-helpers");
function getOrGenerateIdentifier(configuration_key) {
    let mllwtIdentifier = (0, storage_helpers_1.getLocalStorage)("mllwtl_identifier");
    if (!mllwtIdentifier) {
        return generateIdentifier(configuration_key);
    }
    if (mllwtIdentifier && mllwtIdentifier.startsWith(`mllwtl_${configuration_key}`)) {
        return mllwtIdentifier;
    }
    else if (mllwtIdentifier && mllwtIdentifier.startsWith('mllwtl_')) {
        return generateIdentifier(configuration_key, true, mllwtIdentifier);
    }
    else {
        return generateIdentifier(configuration_key);
    }
}
function getIdentifier() {
    return (0, storage_helpers_1.getLocalStorage)("mllwtl_identifier");
}
function generateIdentifier(configuration_key, just_update_key = false, previous_identifier = "") {
    const random_string = just_update_key ? previous_identifier.split("_")[1] : generateRandomString(10);
    const identifier = `mllwtl_${configuration_key}_${random_string}`;
    (0, storage_helpers_1.setLocalStorage)("mllwtl_identifier", identifier);
    return identifier;
}
function generateRandomString(length) {
    return Math.random().toString(36).substring(2, length + 2);
}
