import { dialog, BrowserWindow } from 'electron';

interface ConsentDialogOptions {
    incentive: string;
    acceptButtonText?: string;
    declineButtonText?: string;
    appIconPath?: string;
    dialogTextOverride?: string;
    parentWindow?: BrowserWindow;
}

export async function showConsentDialog({
    incentive,
    acceptButtonText = 'Yes',
    declineButtonText = 'No',
    dialogTextOverride,
    parentWindow
}: ConsentDialogOptions): Promise<boolean> {
    // Construct the message text
    const defaultMessage = `If you click on "Yes", Mellowtel will let you share unused bandwidth with trusted companies who use it to access the internet. A portion of the generated revenue is allocated to this app to maintain its free availability.\n\n` +
        'It shares internet bandwidth only. No personal information is collected.\n\n' +
        'You can opt out at any moment from the settings page.';

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
