import { app, BrowserWindow } from 'electron';
import Mellowtel from 'mellowtel-electron';

function createWindow(): BrowserWindow {
  // Create the browser window
  const win: BrowserWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true
    }
  });

  // Load the index.html file
  win.loadURL('https://github.com');
  return win
}

// When the app is ready, create the window
app.whenReady().then(async () => {
  let win = createWindow();
  await delay(2000);
  // await executeAction( {
  //   'type': 'scroll',
  //   'direction': 'down',
  //   'amount': 1500
  // }, win)
  
  await executeAction({
    type: 'fill_input',
    selector: '#hero_user_email',
    value: 'example@example.com'
  }, win);
  await executeAction({
    type: 'click',
    selector: '.Primer_Brand__Button-module__Button--primary___xIC7G.CtaForm-primaryAction'
  }, win);

  

  // const mellowtel: Mellowtel = new Mellowtel('electrontestkey', {
  //   disableLogs: false
  // });

  // await mellowtel.requestConsent(win, "Get 3 months free")
  // await mellowtel.init()

  // Enable from the settings page.
  // await sdk.showConsentSettings(win);

  // On macOS, create a new window when clicking the dock icon if no windows are open
  app.on('activate', (): void => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit the app when all windows are closed (except on macOS)
app.on('window-all-closed', (): void => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

interface Action {
  type: string;
  [key: string]: any;
}

interface FormField {
  name: string;
  value: string;
}


const delay = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

async function executeAction(action: Action, win: BrowserWindow): Promise<void> {
  switch (action.type) {
      case "wait":
          await delay(action.milliseconds);
          break;
      case "click":
          await win.webContents.executeJavaScript(`document.querySelector("${action.selector}").click();`);
          break;
      case "write":
          await win.webContents.executeJavaScript(`
              const activeElement = document.activeElement;
              if (activeElement && "value" in activeElement) {
                  const start = activeElement.selectionStart || 0;
                  const end = activeElement.selectionEnd || 0;
                  activeElement.value = activeElement.value.substring(0, start) + "${action.text}" + activeElement.value.substring(end);
                  activeElement.selectionStart = activeElement.selectionEnd = start + "${action.text}".length;
              }
          `);
          break;
      case "fill_input":
          await win.webContents.executeJavaScript(`document.querySelector("${action.selector}").value = "${action.value}";`);
          break;
      case "fill_textarea":
          await win.webContents.executeJavaScript(`document.querySelector("${action.selector}").value = "${action.value}";`);
          break;
      case "select":
          await win.webContents.executeJavaScript(`document.querySelector("${action.selector}").value = "${action.value}";`);
          break;
      case "fill_form":
          await win.webContents.executeJavaScript(`
              const formElement = document.querySelector("${action.selector}");
              if (formElement) {
                  const formData = new FormData(formElement);
                  ${action.fields.map((field: FormField) => `formData.set("${field.name}", "${field.value}");`).join('')}
              }
          `);
          break;
      case "press":
          await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "${action.key}" }));`);
          break;
      case "scroll":
          await win.webContents.executeJavaScript(`
              window.scrollBy({
                  top: ${action.direction === "up" ? -action.amount : action.amount},
                  left: ${action.direction === "left" ? -action.amount : action.direction === "right" ? action.amount : 0},
                  behavior: "smooth",
              });
          `);
          break;
      default:
          console.warn(`Unknown action type: ${action.type}`);
  }
}