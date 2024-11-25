import { BrowserWindow } from 'electron';
interface ConsentDialogOptions {
    incentive: string;
    acceptButtonText?: string;
    declineButtonText?: string;
    appIconPath?: string;
    dialogTextOverride?: string;
    parentWindow?: BrowserWindow;
}
export declare function showConsentDialog({ incentive, acceptButtonText, declineButtonText, dialogTextOverride, parentWindow }: ConsentDialogOptions): Promise<boolean>;
export {};
