// Consent v2 (story 3.1, built in 4.1): approved wording, original wording untouched when the proxy is off,
// and the start / ask / jobs-only decision.
import { describe, expect, it } from 'vitest';
import { consentDialogText, proxyConsentAction, settingsText } from '../../src/consent/consent-text';

const ORIGINAL_DIALOG =
    `If you click on "Yes", Mellowtel will let you share unused bandwidth with trusted companies who use it to access the internet. A portion of the generated revenue is allocated to this app to maintain its free availability.\n\n` +
    'It shares internet bandwidth only. No personal information is collected.\n\n' +
    'You can opt out at any moment from the settings page.';

describe('consent wording', () => {
    it('proxy off: the dialog text is exactly the original', () => {
        expect(consentDialogText(false)).toBe(ORIGINAL_DIALOG);
    });

    it('proxy on: the approved v2 dialog text', () => {
        expect(consentDialogText(true)).toBe(
            'If you click on "Yes", Mellowtel will let you share unused bandwidth with trusted companies who use it to access the internet. ' +
                'Some of their web traffic will go out through your internet connection, so websites will see your IP address. ' +
                'A portion of the generated revenue is allocated to this app to maintain its free availability.\n\n' +
                "It shares internet bandwidth only. No personal information is collected. The traffic is encrypted, so Mellowtel can't read it, and it never connects to devices on your home network.\n\n" +
                'You can opt out at any moment from the settings page.',
        );
    });

    it('settings: v2 adds the two sentences; v1 and the opt-out confirmation are unchanged', () => {
        for (const s of ['opted_in', 'opted_out'] as const) {
            const v1 = settingsText(s, false);
            const v2 = settingsText(s, true);
            expect(v1).not.toContain('IP address');
            expect(v2).toContain('companies that use it to access the web. Some of their web traffic goes out through your connection, so websites see your IP address.');
            expect(v2.endsWith("The traffic is encrypted, so Mellowtel can't read it, and it never connects to devices on your home network.")).toBe(true);
            expect(v2.replace(' Some of their web traffic goes out through your connection, so websites see your IP address.', '').replace(" The traffic is encrypted, so Mellowtel can't read it, and it never connects to devices on your home network.", '')).toBe(v1);
        }
        expect(settingsText('confirm_opt_out', true)).toBe(settingsText('confirm_opt_out', false));
    });
});

describe('proxy consent decision', () => {
    const base = { enableProxy: true, optedIn: true as boolean | undefined, storedVersion: 0, declaredVersion: 0, reconsentAsked: false };
    const cases: Array<[string, Partial<typeof base>, string]> = [
        ['app has not enabled the proxy', { enableProxy: false, storedVersion: 2 }, 'off'],
        ['user not opted in', { optedIn: false, storedVersion: 2 }, 'off'],
        ['user has not decided yet', { optedIn: undefined }, 'off'],
        ['accepted v2 in the SDK dialog', { storedVersion: 2 }, 'start'],
        ['app declares its own v2 screen', { declaredVersion: 2 }, 'start'],
        ['opted in under v1, not asked yet', {}, 'ask'],
        ['opted in under v1, declined the v2 dialog', { reconsentAsked: true }, 'jobs-only'],
        ['declined once, later accepted in settings flow', { reconsentAsked: true, storedVersion: 2 }, 'start'],
    ];
    for (const [name, over, want] of cases) {
        it(`${name} → ${want}`, () => expect(proxyConsentAction({ ...base, ...over })).toBe(want));
    }
});
