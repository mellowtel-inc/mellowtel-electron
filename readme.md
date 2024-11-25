# Mellowtel Electron SDK

## Installation

### Using npm

```sh
npm install github:mellowtel-inc/mellowtel-electron
```

### Using yarn
```sh
yarn add github:username/mellowtel-electron
```

## Usage

### TypeScript
```ts
import MellowtelSDK from 'mellowtel-electron';
import { BrowserWindow } from 'electron';

const sdk = new MellowtelSDK('configuration-key');

const window = new BrowserWindow();
let consent = await sdk.requestConsent(/*browser window*/, "Get Premium Free");
if (consent){
    // Activate if any rewards for opt-in user
}
await sdk.init();

// Show consent settings dialog
await sdk.showConsentSettings(window);
```

### JavaScript

```js
const MellowtelSDK = require('mellowtel-electron').default;
const { BrowserWindow } = require('electron');

const sdk = new MellowtelSDK('configuration-key');

// Request user consent
sdk.requestConsent(/*browser window*/, "Get Premium Free")
.then(consent => {
    if (consent){
        // Activate if any rewards for opt-in user
    } 
    sdk.init();
})

// Show consent settings dialog
// return sdk.showConsentSettings(window);
```

## Manual Opt-In and Opt-Out

If you prefer to use your own interface to manage user consent, you can manually opt-in and opt-out users using the following methods:

### TypeScript
```ts
import MellowtelSDK from 'mellowtel-electron';

const sdk = new MellowtelSDK('configuration-key');

// Manually opt-in the user
if (!sdk.getOptInStatus()){
    await sdk.optIn();
}
await sdk.init();

// Manually opt-out the user
await sdk.optOut();
```

### JavaScript
```js
const MellowtelSDK = require('mellowtel-electron').default;

const sdk = new MellowtelSDK('configuration-key');

// Manually opt-in the user
if (!sdk.getOptInStatus()){
    sdk.optIn().then(() => sdk.init());
}

// Manually opt-out the user
sdk.optOut();
```