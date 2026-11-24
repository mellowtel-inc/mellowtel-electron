import { getOrGenerateIdentifier } from "./utils/identity-helpers";
import { Logger } from "./logger/logger";
import { WebSocketManager } from "./websockets";
import { getLocalStorage, setLocalStorage } from "./storage/storage-helpers";
import {
  getTotalRequestCount,
  getDailyRequestCount,
  getRequestCounts,
  getRequestCountForDate,
  getDailyRequestsHistory,
  getRequestCountsInRange
} from "./storage/request-counter";
import { BrowserWindow } from 'electron'
import { showConsentSettings } from "./consent/consent-setttings";
import { showConsentDialog } from "./consent/consent-dialog";
import { CONSENT_VERSION_PROXY, proxyConsentAction, type ProxyConsentAction } from "./consent/consent-text";
import { TunnelClient } from "./proxy/tunnel-client";
import { VERSION } from "./constants";
import { randomBytes } from "crypto";
import os from "os";

// Export app setup utility for command-line flags
export { setupMellowtelApp } from "./utils/app-setup";

const OPT_IN_STATUS_KEY = "mellowtel_opt_in_status";
const CONSENT_VERSION_KEY = "mellowtel_consent_version";
const PROXY_SECRET_KEY = "mellowtel_proxy_secret";
const PROXY_RECONSENT_ASKED_KEY = "mellowtel_proxy_reconsent_asked";

interface MellowtelOptions {
  disableLogs: boolean
  /**
   * Lets this device carry proxied web traffic (off by default). Only runs for
   * users who accepted the consent text that says websites will see their IP
   * address (consent version 2).
   */
  enableProxy?: boolean
  /** Tunnel server address (wss://...). Required when enableProxy is true. */
  proxyServerUrl?: string
  /**
   * For apps that show their own consent screen and call optIn() themselves:
   * set to 2 only if that screen tells users websites will see their IP address.
   */
  consentVersion?: number
}

export default class Mellowtel {
  private configurationKey: string;
  private nodeId: string;
  private options?: MellowtelOptions;
  private disableLogs: boolean = true;
  private wsManager: WebSocketManager = WebSocketManager.getInstance();
  private tunnel: TunnelClient | null = null;
  private initialized = false;

  /**
   * Creates an instance of MellowtelSDK.
   * @param configurationKey - Your configuration key for the SDK received via email.
   * @param options - Optional configuration options.
   */
  constructor(configurationKey: string, options?: MellowtelOptions) {
    this.configurationKey = configurationKey;
    this.options = options;
    this.disableLogs = options?.disableLogs !== undefined ? options.disableLogs : true;
    Logger.disableLogs = this.disableLogs;
    this.nodeId = getOrGenerateIdentifier(configurationKey);
    Logger.log(this.nodeId);
  }

  /**
   * Signals Mellowtel to start operating if consent is provided.
   * 
   * @returns Promise<void>
   * @throws Error if the configuration key is empty.
   */
  public async init(): Promise<void> {
    if (!this.configurationKey) {
      throw new Error("configurationKey is undefined, null, or empty");
    }

    if (!this.getOptInStatus()) {
      Logger.log("User is not opted in. WebSocket connection will not be established.");
      return;
    }

    await this.wsManager.initialize(this.nodeId);
    this.initialized = true;
    this.startProxyIfAllowed();
    Logger.log("Mellowtel initialized");
  }

  private proxyAction(): ProxyConsentAction {
    return proxyConsentAction({
      enableProxy: this.options?.enableProxy === true,
      optedIn: this.getOptInStatus(),
      storedVersion: Number(getLocalStorage(CONSENT_VERSION_KEY) ?? 0),
      declaredVersion: Number(this.options?.consentVersion ?? 0),
      reconsentAsked: getLocalStorage(PROXY_RECONSENT_ASKED_KEY) === true,
    });
  }

  private startProxyIfAllowed(): void {
    if (this.tunnel || this.proxyAction() !== "start") return;
    const url = this.options?.proxyServerUrl;
    if (!url) {
      Logger.log("Proxy enabled but no proxyServerUrl set; not starting the tunnel.");
      return;
    }
    let secret = getLocalStorage(PROXY_SECRET_KEY);
    if (typeof secret !== "string" || secret.length < 43) {
      secret = randomBytes(32).toString("base64url");
      setLocalStorage(PROXY_SECRET_KEY, secret);
    }
    const p = os.platform();
    this.tunnel = new TunnelClient({
      url,
      deviceId: this.nodeId,
      secret,
      sdk: VERSION,
      platform: `electron-${p === "darwin" ? "macos" : p === "win32" ? "windows" : "linux"}`,
      consentVersion: Math.max(Number(getLocalStorage(CONSENT_VERSION_KEY) ?? 0), Number(this.options?.consentVersion ?? 0)),
      log: (msg, data) => Logger.log(`[proxy] ${msg}`, data ?? ""),
    });
    this.tunnel.start();
  }

  private async stopProxy(reason: "optout" | "shutdown"): Promise<void> {
    const t = this.tunnel;
    this.tunnel = null;
    if (t) await t.stop(reason);
  }

  /**
   * Requests user consent by showing a dialog explaining 
   * about Mellowtel and the incentive for providing consent.
   * 
   * Only shown once until consent has been provided or denied.
   * 
   * @param window - The Electron BrowserWindow instance.
   * @param incentive - The incentive to show in the consent dialog.
   * @returns Promise<boolean | undefined> - Returns true if the user provided consent, false if denied, and undefined if consent was already provided.
   */
  public async requestConsent(
    window: BrowserWindow,
    incentive: string,
  ): Promise<boolean | undefined> {
    const proxy = this.options?.enableProxy === true;
    if (getLocalStorage(OPT_IN_STATUS_KEY) == undefined) {
      let result = await showConsentDialog({
        incentive: incentive,
        acceptButtonText: "Yes, accept",
        declineButtonText: "Later",
        parentWindow: window!,
        proxy
      });

      setLocalStorage(OPT_IN_STATUS_KEY, result);
      if (result && proxy) setLocalStorage(CONSENT_VERSION_KEY, CONSENT_VERSION_PROXY);
      return result;
    } else if (this.proxyAction() === "ask") {
      // Opted in under the earlier text: ask once about the proxy. "No" keeps everything else as it was.
      setLocalStorage(PROXY_RECONSENT_ASKED_KEY, true);
      const result = await showConsentDialog({
        incentive: incentive,
        acceptButtonText: "Yes, accept",
        declineButtonText: "No",
        parentWindow: window!,
        proxy: true
      });
      if (result) {
        setLocalStorage(CONSENT_VERSION_KEY, CONSENT_VERSION_PROXY);
        if (this.initialized) this.startProxyIfAllowed();
      }
      return result;
    } else {
      Logger.log("Consent already provided");
      return undefined;
    }
  }

  /**
   * Shows the consent settings dialog for the user to manage their consent.
   * 
   * @param window - The Electron BrowserWindow instance.
   * @returns Promise<void>
   */
  public async showConsentSettings(window: BrowserWindow): Promise<void> {
    await showConsentSettings({
      initiallyOptedIn: this.getOptInStatus() ?? false,
      nodeId: this.nodeId,
      parentWindow: window,
      proxy: this.options?.enableProxy === true,
      onOptIn: async () => {
        await this.optIn();
        await this.wsManager.initialize(this.nodeId);
        this.initialized = true;
        this.startProxyIfAllowed();
      },
      onOptOut: async () => {
        await this.optOut();
      }
    });
  }

  /**
   * Gets the current opt-in status.
   * @returns boolean | undefined - Returns true if the user is opted in, false if not and undefined if user hasn't decided yet.
   */
  public getOptInStatus(): boolean | undefined {
    const status = getLocalStorage(OPT_IN_STATUS_KEY);
    return status;
  }

  /**
   * Returns the mellowtel node id
   */
  public getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Manually opts in the user to the service from your own interface.
   * @returns Promise<void>
   */
  public async optIn(): Promise<void> {
    setLocalStorage(OPT_IN_STATUS_KEY, true);
    Logger.log("User opted in");
  }

  /**
   * Manually opts out the user from the service from your own interface. Disconnects WebSocket if connected.
   * @returns Promise<void>
   */
  public async optOut(): Promise<void> {
    setLocalStorage(OPT_IN_STATUS_KEY, false);
    await this.stopProxy("optout");
    await this.shutdown();
    Logger.log("User opted out");
  }

  /**
   * Stops Mellowtel and releases all background resources without changing
   * the user's opt-in preference. Call this when the host app is closing.
   */
  public async shutdown(): Promise<void> {
    this.initialized = false;
    await this.stopProxy("shutdown");
    await this.wsManager.shutdown();
    Logger.log("Mellowtel shut down");
  }

  /**
   * Gets the total number of requests processed since installation.
   * @returns number - The total request count
   */
  public getTotalRequestCount(): number {
    return getTotalRequestCount();
  }

  /**
   * Gets the number of requests processed today.
   * @returns number - The daily request count for today
   */
  public getDailyRequestCount(): number {
    return getDailyRequestCount();
  }

  /**
   * Gets the number of requests processed on a specific date.
   * @param date - The date in YYYY-MM-DD format (e.g., "2025-10-29")
   * @returns number - The request count for that date
   */
  public getRequestCountForDate(date: string): number {
    return getRequestCountForDate(date);
  }

  /**
   * Gets all historical daily request counts.
   * @returns Object with dates as keys (YYYY-MM-DD) and request counts as values
   */
  public getDailyRequestsHistory(): { [date: string]: number } {
    return getDailyRequestsHistory();
  }

  /**
   * Gets request counts for a specific date range.
   * @param startDate - Start date in YYYY-MM-DD format
   * @param endDate - End date in YYYY-MM-DD format
   * @returns Object with dates as keys and request counts as values for the specified range
   */
  public getRequestCountsInRange(startDate: string, endDate: string): { [date: string]: number } {
    return getRequestCountsInRange(startDate, endDate);
  }

  /**
   * Gets detailed request count information including total, daily (today), and complete history.
   * @returns Object containing total requests, daily requests for today, and all historical daily counts
   */
  public getRequestCounts(): { total: number; daily: number; dailyHistory: { [date: string]: number } } {
    return getRequestCounts();
  }
}
