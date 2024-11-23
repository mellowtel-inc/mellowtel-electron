import Store from 'electron-store';

const store = new Store();

export function getLocalStorage(key: string): any {
  return store.get(key);
}

export function setLocalStorage(key: string, value: any): boolean {
  store.set(key, value);
  return true;
}

export function deleteLocalStorage(keys: string[]): boolean {
  keys.forEach((key) => store.delete(key));
  return true;
}
