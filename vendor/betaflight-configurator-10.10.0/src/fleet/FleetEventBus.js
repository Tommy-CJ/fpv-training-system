const listeners = new Map();

export function onFleetEvent(eventName, listener) {
    const eventListeners = listeners.get(eventName) || new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
    return () => {
        eventListeners.delete(listener);
        if (!eventListeners.size) listeners.delete(eventName);
    };
}

export function emitFleetEvent(eventName, payload = {}) {
    for (const listener of listeners.get(eventName) || []) listener(payload);
    for (const listener of listeners.get("*") || []) listener({ eventName, payload });
}

