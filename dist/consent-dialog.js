"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showConsentDialog = showConsentDialog;
const electron_1 = require("electron");
async function showConsentDialog({ 
// appName,
incentive, acceptButtonText = 'Yes', declineButtonText = 'No', dialogTextOverride, parentWindow }) {
    // Construct the message text
    const defaultMessage = `${incentive}. If you click on "Yes", you can share your unused bandwidth with Mellowtel to enable access to public websites helping provide you the above incentive.\n\n` +
        'It shares internet bandwidth only. No personal information is collected.\n\n' +
        'You can opt out at any moment from the settings page.';
    const messageText = dialogTextOverride || defaultMessage;
    const result = await electron_1.dialog.showMessageBox(parentWindow, {
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
