// @ts-check
/**
 * Keeps the last take in this browser (IndexedDB) so a refresh or a closed
 * tab doesn't lose a recording. Nothing leaves the device.
 */
const DB = 'retake';
const STORE = 'takes';

function open() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

/** @param {any} take */
export async function saveTake(take) {
  try {
    const db = /** @type {IDBDatabase} */ (await open());
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(take, 'last');
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<any|null>} */
export async function loadTake() {
  try {
    const db = /** @type {IDBDatabase} */ (await open());
    const take = await new Promise((res, rej) => {
      const req = db.transaction(STORE).objectStore(STORE).get('last');
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return take;
  } catch {
    return null;
  }
}

/** Settings that are a per-person convenience. */
export const prefs = {
  /** @param {string} k */
  get(k) {
    try {
      return localStorage.getItem(`retake:${k}`);
    } catch {
      return null;
    }
  },
  /** @param {string} k @param {string} v */
  set(k, v) {
    try {
      localStorage.setItem(`retake:${k}`, v);
    } catch {
      /* storage blocked */
    }
  },
};
