import { BrowserWindow } from 'electron';
interface ConsentSettingsOptions {
    initiallyOptedIn: boolean;
    onOptIn: () => Promise<void>;
    onOptOut: () => Promise<void>;
    nodeId: string;
    parentWindow?: BrowserWindow;
}
export declare function showConsentSettings({ initiallyOptedIn, onOptIn, onOptOut, nodeId, parentWindow }: ConsentSettingsOptions): Promise<void>;
export {};
