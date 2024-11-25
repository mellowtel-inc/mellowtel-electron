"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
class Logger {
    static log(message, ...optionalParams) {
        if (!Logger.disableLogs) {
            console.log(message, ...optionalParams);
        }
    }
    static error(message, ...optionalParams) {
        if (!Logger.disableLogs) {
            console.error(message, ...optionalParams);
        }
    }
}
exports.Logger = Logger;
Logger.disableLogs = true;
