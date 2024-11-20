export class Logger {
    private static disableLogs = true;
  
    static setLogEnabled(enabled: boolean) {
      this.disableLogs = !enabled;
    }
  
    static log(...args: any[]) {
      if (!this.disableLogs) {
        console.log('[Mellowtel]', ...args);
      }
    }
  
    static error(...args: any[]) {
      if (!this.disableLogs) {
        console.error('[Mellowtel]', ...args);
      }
    }
  }
  