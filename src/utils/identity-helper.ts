
import crypto from 'crypto';
import { MellowtelStore } from '../store';

export async function getOrGenerateIdentifier(
  configKey: string,
): Promise<string> {
    const store = MellowtelStore.getInstance();
  const nodeId = store.getNodeId();
  
  if (!nodeId) {
    return generateIdentifier(configKey, store);
  }
  
  if (nodeId.startsWith(`mllwtl_${configKey}`)) {
    return nodeId;
  }
  
  return nodeId.startsWith('mllwtl_')
    ? generateIdentifier(configKey, store, true, nodeId)
    : generateIdentifier(configKey, store);
}

export async function generateIdentifier(
  configKey: string,
  store: MellowtelStore,
  updateKeyOnly = false,
  prevIdentifier = ''
): Promise<string> {
  const randomStr = updateKeyOnly
    ? prevIdentifier.split('_')[1]
    : crypto.randomBytes(5).toString('hex');
    
  const identifier = `mllwtl_${configKey}_${randomStr}`;
  store.setState({ nodeId: identifier });
  return identifier;
}

export function getIdentifier(store: MellowtelStore): string {
  return store.getNodeId();
}

// These remain unchanged since they're Electron-specific
export function getExtensionIdentifier(): string {
  try {
    return process.pid.toString();
  } catch {
    return 'identifier_not_found';
  }
}

export function getExtensionName(): string {
  try {
    return require('../package.json').name;
  } catch {
    return 'extension_name_not_found'; 
  }
}