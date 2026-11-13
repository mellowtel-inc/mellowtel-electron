import { dialog, BrowserWindow } from 'electron';
import { consentDialogText } from './consent-text';

interface ConsentDialogOptions {
    incentive: string;
    acceptButtonText?: string;
    declineButtonText?: string;
    appIconPath?: string;
    dialogTextOverride?: string;
    parentWindow?: BrowserWindow;
    /** Show the wording for the proxy feature (consent version 2). */
    proxy?: boolean;
}

export async function showConsentDialog({
    incentive,
    acceptButtonText = 'Yes',
    declineButtonText = 'No',
    dialogTextOverride,
    parentWindow,
    proxy = false
}: ConsentDialogOptions): Promise<boolean> {
    // Construct the message text
    const defaultMessage = consentDialogText(proxy);

    const messageText = dialogTextOverride || defaultMessage;
    
    const result = await dialog.showMessageBox(parentWindow!, {
        type: 'info',
        // title: appName,
        message: incentive,
        detail: messageText,
        buttons: [acceptButtonText, declineButtonText],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
    });
    // Return true for accept, false for decline
    return result.response === 0;
}
