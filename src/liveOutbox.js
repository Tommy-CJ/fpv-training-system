const DB_NAME = "fpv-training-live-outbox";
const DB_VERSION = 1;
const STORE_NAME = "packets";
let databasePromise = null;
let databaseInstance = null;

function invalidateDatabase(database) {
  if (database && databaseInstance && database !== databaseInstance) return;
  try {
    databaseInstance?.close();
  } catch {
    // The browser may already have closed an invalid IndexedDB connection.
  }
  databaseInstance = null;
  databasePromise = null;
}

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "packetId" });
        store.createIndex("capturedAt", "capturedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      databaseInstance = database;
      database.onversionchange = () => invalidateDatabase(database);
      database.onclose = () => invalidateDatabase(database);
      resolve(database);
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      databasePromise = null;
      reject(new Error("实时数据缓存数据库被其他页面阻塞"));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      databasePromise = null;
      reject(request.error || new Error("无法打开实时数据缓存"));
    };
  });
  return databasePromise;
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("本地实时数据缓存操作失败"));
    transaction.onabort = () => reject(transaction.error || new Error("本地实时数据缓存操作被中止"));
  });
}

async function withPacketStore(mode, operation, retry = true) {
  const database = await openDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const completed = transactionComplete(transaction);
    const result = await operation(transaction.objectStore(STORE_NAME));
    await completed;
    return result;
  } catch (error) {
    invalidateDatabase(database);
    if (retry) return withPacketStore(mode, operation, false);
    throw error;
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地实时数据缓存操作失败"));
  });
}

export async function cacheLivePacket(record) {
  await withPacketStore("readwrite", (store) => {
    store.put(record);
  });
}

export async function deleteCachedLivePacket(packetIdOrIds) {
  const packetIds = Array.isArray(packetIdOrIds) ? packetIdOrIds : [packetIdOrIds];
  await withPacketStore("readwrite", (store) => {
    for (const packetId of packetIds) {
      if (packetId) store.delete(packetId);
    }
  });
}

export async function listCachedLivePackets(limit = 120) {
  const records = await withPacketStore("readonly", (store) => (
    requestResult(store.index("capturedAt").getAll(null, Math.max(1, Number(limit) || 120)))
  ));
  return Array.isArray(records) ? records : [];
}
