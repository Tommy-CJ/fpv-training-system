const DB_NAME = "fpv-training-live-outbox";
const DB_VERSION = 2;
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
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "packetId" });
      if (!store.indexNames.contains("capturedAt")) {
        store.createIndex("capturedAt", "capturedAt", { unique: false });
      }
      if (!store.indexNames.contains("eventCapturedAt")) {
        store.createIndex("eventCapturedAt", ["eventId", "capturedAt"], { unique: false });
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

export async function deleteCachedLivePacketsByEventId(eventId) {
  const safeEventId = String(eventId || "");
  if (!safeEventId) return 0;
  let deleted = 0;
  await withPacketStore("readwrite", (store) => new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(
      [safeEventId, 0],
      [safeEventId, Number.MAX_SAFE_INTEGER],
    );
    const request = store.index("eventCapturedAt").openKeyCursor(range);
    request.onerror = () => reject(request.error || new Error("无法扫描指定事件的断网缓存"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      deleted += 1;
      cursor.continue();
    };
  }));
  return deleted;
}

export async function listCachedLivePackets(limit = 120, deferredPacketIds = [], {
  priorityEventId = "",
  capturedAtCutoff = Number.MAX_SAFE_INTEGER,
} = {}) {
  const maxRegularRecords = Math.max(1, Number(limit) || 120);
  const deferred = new Set(deferredPacketIds || []);
  const deferredPreviewLimit = Math.min(10, deferred.size);
  const records = await withPacketStore("readonly", (store) => new Promise((resolve, reject) => {
    const collected = [];
    const collectedPacketIds = new Set();
    let regularCount = 0;
    let deferredPreviewCount = 0;
    const collectRecord = (record) => {
      if (!record?.packetId || collectedPacketIds.has(record.packetId)) return;
      if (deferred.has(record?.packetId)) {
        if (deferredPreviewCount < deferredPreviewLimit) {
          collected.push(record);
          collectedPacketIds.add(record.packetId);
          deferredPreviewCount += 1;
        }
      } else {
        collected.push(record);
        collectedPacketIds.add(record.packetId);
        regularCount += 1;
      }
    };
    const scanByCaptureTime = () => {
      if (regularCount >= maxRegularRecords) {
        resolve(collected);
        return;
      }
      // New recovery data must never wait behind years of older debug cache.
      // Walk newest-first after the active-event priority query; historical
      // insertion is order-independent and the server rebuilds once at the end.
      const request = store.index("capturedAt").openCursor(null, "prev");
      request.onerror = () => reject(request.error || new Error("无法扫描本地实时数据缓存"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(collected);
          return;
        }
        collectRecord(cursor.value);
        if (regularCount >= maxRegularRecords) {
          resolve(collected);
          return;
        }
        cursor.continue();
      };
    };

    const safePriorityEventId = String(priorityEventId || "");
    const safeCutoff = Number(capturedAtCutoff) || Number.MAX_SAFE_INTEGER;
    if (!safePriorityEventId || !store.indexNames.contains("eventCapturedAt")) {
      scanByCaptureTime();
      return;
    }
    const priorityRange = IDBKeyRange.bound(
      [safePriorityEventId, 0],
      [safePriorityEventId, safeCutoff],
    );
    const priorityRequest = store.index("eventCapturedAt").getAll(priorityRange, maxRegularRecords);
    priorityRequest.onerror = () => reject(priorityRequest.error || new Error("无法读取当前训练断网缓存"));
    priorityRequest.onsuccess = () => {
      for (const record of priorityRequest.result || []) collectRecord(record);
      if (regularCount >= maxRegularRecords) {
        resolve(collected);
        return;
      }
      scanByCaptureTime();
    };
  }));
  return Array.isArray(records) ? records : [];
}
