/**
 * Consent wording. Version 1 is the original text and is shown whenever the
 * proxy feature is off. Version 2 adds what changes for the user when the
 * proxy is on: websites see their IP address for some traffic.
 */
export const CONSENT_VERSION_PROXY = 2;

const DIALOG_V1 =
    `If you click on "Yes", Mellowtel will let you share unused bandwidth with trusted companies who use it to access the internet. A portion of the generated revenue is allocated to this app to maintain its free availability.\n\n` +
    'It shares internet bandwidth only. No personal information is collected.\n\n' +
    'You can opt out at any moment from the settings page.';

const DIALOG_V2 =
    `If you click on "Yes", Mellowtel will let you share unused bandwidth with trusted companies who use it to access the internet. Some of their web traffic will go out through your internet connection, so websites will see your IP address. A portion of the generated revenue is allocated to this app to maintain its free availability.\n\n` +
    "It shares internet bandwidth only. No personal information is collected. The traffic is encrypted, so Mellowtel can't read it, and it never connects to devices on your home network.\n\n" +
    'You can opt out at any moment from the settings page.';

const IP_SENTENCE = ' Some of their web traffic goes out through your connection, so websites see your IP address.';
const SAFETY_SENTENCE = " The traffic is encrypted, so Mellowtel can't read it, and it never connects to devices on your home network.";

const OPTED_IN_V1 =
    "Mellowtel is an open-source library that lets you share your unused internet with companies that use it to access the web. The developer of this app gets a share of the revenue. It helps maintain this app free and available for everyone. Mellowtel shares your bandwidth only. Security and privacy are 100% guaranteed. It doesn't collect, share, or sell personal information (not even anonymized data).";
const OPTED_OUT_V1 =
    "You are currently opted out. By opting in, Mellowtel lets you share your unused internet with companies that use it to access the web. The developer of this app gets a share of the revenue. It helps maintain this app free and available for everyone.\n\nMellowtel shares your bandwidth only. Security and privacy are 100% guaranteed. It doesn't collect, share, or sell personal information (not even anonymized data).";
const CONFIRM_OPT_OUT =
    'Mellowtel is used by hundreds of thousands of users around the world. By remaining opted in, you will join this growing network of users. Security, privacy and speed of browsing are 100% guaranteed.\n\nOpting-out might negatively affect the quality of the service offered by this app. Please consider staying opted-in to keep your incentives available.';

const ACCESS_THE_WEB = 'companies that use it to access the web.';

export function consentDialogText(proxy: boolean): string {
    return proxy ? DIALOG_V2 : DIALOG_V1;
}

export type SettingsState = 'opted_in' | 'opted_out' | 'confirm_opt_out';

export function settingsText(state: SettingsState, proxy: boolean): string {
    if (state === 'confirm_opt_out') return CONFIRM_OPT_OUT;
    const base = state === 'opted_in' ? OPTED_IN_V1 : OPTED_OUT_V1;
    if (!proxy) return base;
    return base.replace(ACCESS_THE_WEB, ACCESS_THE_WEB + IP_SENTENCE) + SAFETY_SENTENCE;
}

export interface ProxyConsentInput {
    enableProxy: boolean;
    optedIn: boolean | undefined;
    /** Version stored when the user accepted a dialog shown by this SDK. */
    storedVersion: number;
    /** Version the app declares for its own consent screen (apps that call optIn() themselves). */
    declaredVersion: number;
    reconsentAsked: boolean;
}

/**
 * off       – proxy not enabled by the app, or the user isn't opted in
 * start     – the user accepted version 2: the tunnel may run
 * ask       – opted in under version 1: show the version 2 dialog once
 * jobs-only – asked once and declined: keep jobs as before, never the proxy
 */
export type ProxyConsentAction = 'off' | 'start' | 'ask' | 'jobs-only';

export function proxyConsentAction(i: ProxyConsentInput): ProxyConsentAction {
    if (!i.enableProxy || i.optedIn !== true) return 'off';
    if (Math.max(i.storedVersion, i.declaredVersion) >= CONSENT_VERSION_PROXY) return 'start';
    return i.reconsentAsked ? 'jobs-only' : 'ask';
}
