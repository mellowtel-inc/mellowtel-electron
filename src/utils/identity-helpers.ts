import { getLocalStorage, setLocalStorage } from "../storage/storage-helpers";

export function getOrGenerateIdentifier(configuration_key: string): string {
  let mllwtIdentifier: string | undefined = getLocalStorage("mllwtl_identifier")

  if (!mllwtIdentifier) {
    return generateIdentifier(configuration_key);
  }
  if (mllwtIdentifier && mllwtIdentifier.startsWith(`mllwtl_${configuration_key}`)) {
    return mllwtIdentifier;
  } else if (mllwtIdentifier && mllwtIdentifier.startsWith('mllwtl_')) {
    return generateIdentifier(configuration_key, true, mllwtIdentifier);
  } else {

    return generateIdentifier(configuration_key);
  }
}
export function getIdentifier(): string {
  return getLocalStorage("mllwtl_identifier")
}

function generateIdentifier(configuration_key: string, just_update_key: boolean = false, previous_identifier: string = ""): string {

  const random_string: string = just_update_key ? previous_identifier.split("_")[2] : generateRandomString(10);
  const identifier: string = `mllwtl_${configuration_key}_${random_string}`;
  setLocalStorage("mllwtl_identifier", identifier)
  return identifier;
}

function generateRandomString(length: number): string {
  return Math.random().toString(36).substring(2, length + 2);
}