import { dialog, BrowserWindow } from 'electron';
import { settingsText } from './consent-text';

enum ContainerState {
    OPTED_IN = 'opted_in',
    OPTED_OUT = 'opted_out',
    CONFIRM_OPT_OUT = 'confirm_opt_out'
}

interface ConsentSettingsOptions {
    initiallyOptedIn: boolean;
    onOptIn: () => Promise<void>;
    onOptOut: () => Promise<void>;
    nodeId: string;
    parentWindow?: BrowserWindow;
    /** Show the wording for the proxy feature (consent version 2). */
    proxy?: boolean;
}

export async function showConsentSettings({
    initiallyOptedIn,
    onOptIn,
    onOptOut,
    nodeId,
    parentWindow,
    proxy = false
}: ConsentSettingsOptions): Promise<void> {
    let currentState: ContainerState = initiallyOptedIn ? ContainerState.OPTED_IN : ContainerState.OPTED_OUT;

    while (true) {
        let messageText = getInformationText(currentState, proxy);
        let buttons: string[] = [];
        let defaultId: number = 0;

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

        const result = await dialog.showMessageBox(parentWindow!, {
            type: 'info',
            message: "Manage Consent",
            detail: messageText + (currentState === ContainerState.OPTED_IN ? `\n\Device Id: ${nodeId}` : ''),
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

function getInformationText(state: ContainerState, proxy: boolean): string {
    return settingsText(state as `${ContainerState}`, proxy);
}
