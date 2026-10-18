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
  constructor(storage = window.localStorage) { this.storage = storage; }
  get(key, fallback = null) {
    const value = this.storage.getItem(key);
    if (value === null) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
  }
  set(key, value) {
    this.storage.setItem(key, JSON.stringify(value));
    notifyRepositoryChange('set', key, this.storage);
  }
  remove(key) {
    this.storage.removeItem(key);
    notifyRepositoryChange('remove', key, this.storage);
  }
};
