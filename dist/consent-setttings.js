"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showConsentSettings = showConsentSettings;
const electron_1 = require("electron");
var ContainerState;
(function (ContainerState) {
    ContainerState["OPTED_IN"] = "opted_in";
    ContainerState["OPTED_OUT"] = "opted_out";
    ContainerState["CONFIRM_OPT_OUT"] = "confirm_opt_out";
})(ContainerState || (ContainerState = {}));
async function showConsentSettings({ 
// appName,
initiallyOptedIn, onOptIn, onOptOut, nodeId, parentWindow }) {
    let currentState = initiallyOptedIn ? ContainerState.OPTED_IN : ContainerState.OPTED_OUT;
    while (true) {
        let messageText = getInformationText(currentState);
        let buttons = [];
        let defaultId = 0;
        switch (currentState) {
            case ContainerState.OPTED_IN:
                buttons = ['Close', 'Opt Out'];
                defaultId = 0;
                break;
            case ContainerState.OPTED_OUT:
                buttons = ['Opt In', 'Close'];
                defaultId = 0;
                break;
            case ContainerState.CONFIRM_OPT_OUT:
                buttons = ['Close', "I'm sure"];
                defaultId = 0;
                break;
        }
        const result = await electron_1.dialog.showMessageBox(parentWindow, {
            type: 'info',
            message: "Consent Settings",
            // title: appName,
            // message: `${appName} - Consent Settings`,
            detail: messageText + (currentState === ContainerState.OPTED_IN ? `\n\nNode ID: ${nodeId}` : ''),
            buttons: buttons,
            defaultId: defaultId,
            cancelId: 1,
            noLink: false,
        });
        // Handle button clicks
        switch (currentState) {
            case ContainerState.OPTED_IN:
                if (result.response === 1) { // Opt Out clicked
                    currentState = ContainerState.CONFIRM_OPT_OUT;
                    continue;
                }
                break;
            case ContainerState.OPTED_OUT:
                if (result.response === 0) { // Opt In clicked
                    await onOptIn();
                }
                break;
            case ContainerState.CONFIRM_OPT_OUT:
                if (result.response === 1) { // I'm sure clicked
                    await onOptOut();
                }
                break;
        }
        // If we reach here, dialog should be closed
        break;
    }
}
function getInformationText(state) {
    switch (state) {
        case ContainerState.OPTED_IN:
            return "Mellowtel is an open-source library that lets you share your unused internet with trusted startups who use it to access and retrieve information from public websites. The developer of this app gets a small share of the revenue. It helps maintain this app free. Mellowtel shares internet bandwidth only.\n\nNone of your personal information (not even anonymized data) is collected except the IP address which is used just to infer the country of origin to provide geo-specific services.";
        case ContainerState.OPTED_OUT:
            return 'You are currently opted out. Your device\'s resources are not being used.';
        case ContainerState.CONFIRM_OPT_OUT:
            return 'Mellowtel is used by hundreds of thousands of users around the world. By remaining opted in, you will join this growing network of users. Security, privacy and speed of browsing are 100% guaranteed.\n\nOpting-out might negatively affect the quality of the service offered by this app. Please consider staying opted-in to keep your incentives available.';
    }
}
