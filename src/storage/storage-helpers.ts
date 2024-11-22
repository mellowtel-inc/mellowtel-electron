import Store from 'electron-store';

const store = new Store();

export function getLocalStorage(key: string, extract_key = false): Promise<any> {
  return new Promise((resolve) => {
    const result = store.get(key);
    if (extract_key) {
      resolve(result ? result[key] : null);
    } else {
      resolve(result);
    }
  });
}

export function setLocalStorage(key: string, value: any): Promise<boolean> {
  return new Promise((resolve) => {
    store.set(key, value);
    resolve(true);
  });
}

export function deleteLocalStorage(keys: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    keys.forEach((key) => store.delete(key));
    resolve(true);
  });
}