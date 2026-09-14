import { currentJobTrace } from "../observability/trace";

export class Logger {
    static disableLogs: boolean = true;

    static log(message: string, ...optionalParams: any[]) {
      currentJobTrace()?.add("info", message, optionalParams);
      if (!Logger.disableLogs) {
        console.log(message, ...optionalParams);
      }
    }

    static error(message: string, ...optionalParams: any[]) {
      currentJobTrace()?.add("error", message, optionalParams);
      if (!Logger.disableLogs) {
        console.error(message, ...optionalParams);
      }
    }
  }