'use strict';

// Persistence boundary. Keys stay compatible with the original annotator.
// Remote persistence will need async action boundaries; scope logic stays pure.
// Writes are announced through window.__repoChanged so a sync layer can mirror
// them without this class knowing anything about the network.

function notifyRepositoryChange(type, key, storage) {
  if (typeof window.__repoChanged !== 'function') return;
  try { window.__repoChanged(type, key, storage); } catch (error) { console.error('[repository hook]', error); }
}

window.AnnotationRepository = class AnnotationRepository {
  static account = '';
  static workspaceKey(key) {
    return /^annotator\.(?:projects\.v1$|deleted-projects\.v1$|(?:labels|data|caps|pos)\.v1\.)/.test(key);
  }
  static useAccount(id, storage = window.localStorage) {
    if (!id) { this.account = ''; return; }
    const prefix = 'annotator.account.' + encodeURIComponent(id) + '.';
    this.account = prefix;
    const ownerKey = 'annotator.legacy-owner.v1';
    // Reserve existing keys for their first authenticated owner. This avoids
    // copying large imported files and exhausting the browser storage quota.
    let owner = storage.getItem(ownerKey);
    if (!owner) { storage.setItem(ownerKey, id); owner = id; }
    this.account = owner === id ? '' : prefix;
  }
  constructor(storage = window.localStorage) { this.storage = storage; }
  key(key) {
    return AnnotationRepository.workspaceKey(key) ? AnnotationRepository.account + key : key;
  }
  get(key, fallback = null) {
    const value = this.storage.getItem(this.key(key));
    if (value === null) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  }
  set(key, value) {
    this.storage.setItem(this.key(key), JSON.stringify(value));
    notifyRepositoryChange('set', key, this.storage);
  }
  remove(key) {
    this.storage.removeItem(this.key(key));
    notifyRepositoryChange('remove', key, this.storage);
  }
};
