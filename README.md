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
import Mellowtel from 'mellowtel-electron';
import { BrowserWindow } from 'electron';

const mellowtel = new Mellowtel('configuration-key');

const window = new BrowserWindow();
let consent = await mellowtel.requestConsent(/*browser window*/, "Get Premium Free");
if (consent){
    // Activate if any rewards for opt-in user
}
await mellowtel.init();

// Show consent settings dialog
await mellowtel.showConsentSettings(window);
```

### JavaScript

```js
const Mellowtel = require('mellowtel-electron').default;
const { BrowserWindow } = require('electron');

const mellowtel = new Mellowtel('configuration-key');

// Request user consent
mellowtel.requestConsent(/*browser window*/, "Get Premium Free")
.then(consent => {
    if (consent){
        // Activate if any rewards for opt-in user
    } 
    mellowtel.init();
})

// Show consent settings dialog
// return mellowtel.showConsentSettings(window);
```

## Manual Opt-In and Opt-Out

If you prefer to use your own interface to manage user consent, you can manually opt-in and opt-out users using the following methods:

### TypeScript
```ts
import Mellowtel from 'mellowtel-electron';

const mellowtel = new Mellowtel('configuration-key');

// Manually opt-in the user
if (!mellowtel.getOptInStatus()){
    await mellowtel.optIn();
}
await mellowtel.init();

// Manually opt-out the user
await mellowtel.optOut();
```

### JavaScript
```js
const Mellowtel = require('mellowtel-electron').default;

const mellowtel = new Mellowtel('configuration-key');

// Manually opt-in the user
if (!mellowtel.getOptInStatus()){
    mellowtel.optIn().then(() => mellowtel.init());
}

// Manually opt-out the user
mellowtel.optOut();
```