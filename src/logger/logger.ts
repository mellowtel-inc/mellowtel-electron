export class Logger {
    static disableLogs: boolean = true;
  
    static log(message: string, ...optionalParams: any[]) {
      if (!Logger.disableLogs) {
        console.log(message, ...optionalParams);
      }
    }
  
    static error(message: string, ...optionalParams: any[]) {
      if (!Logger.disableLogs) {
        console.error(message, ...optionalParams);
      }
    }
  }