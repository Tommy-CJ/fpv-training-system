type FleetListener = (payload: unknown) => void;

const listeners = new Map<string, Set<FleetListener>>();

export function onFleetEvent(eventName: string, listener: FleetListener) {
    const eventListeners = listeners.get(eventName) ?? new Set<FleetListener>();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
    return () => {
        eventListeners.delete(listener);
        if (eventListeners.size === 0) listeners.delete(eventName);
    };
}

export function emitFleetEvent(eventName: string, payload: unknown = {}) {
    for (const listener of listeners.get(eventName) ?? []) listener(payload);
    for (const listener of listeners.get("*") ?? []) listener({ eventName, payload });
}

