"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLocalStorage = getLocalStorage;
exports.setLocalStorage = setLocalStorage;
exports.deleteLocalStorage = deleteLocalStorage;
const electron_store_1 = __importDefault(require("electron-store"));
const store = new electron_store_1.default();
function getLocalStorage(key) {
    return store.get(key);
}
function setLocalStorage(key, value) {
    store.set(key, value);
    return true;
}
function deleteLocalStorage(keys) {
    keys.forEach((key) => store.delete(key));
    return true;
}
