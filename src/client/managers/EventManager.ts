// No longer extending EventEmitter
import { logger } from '../../utils/logger.js'; // Assuming shared logger

// Type alias for the cleanup function returned by addListener
type CleanupFunction = () => void;

// Type for the listener callback
type EventListenerCallback = (...args: any[]) => void;

/**
 * Manages event subscriptions and listener lifecycle for events received
 * from the Gateway Server or generated internally within the client.
 * Provides a mechanism to clean up listeners to prevent memory leaks.
 */
export class EventManager { // REMOVED: extends EventEmitter
    // Use a Map where keys are event names and values are Sets of listener callbacks
    private listeners: Map<string, Set<EventListenerCallback>> = new Map();

    constructor() {
        // No super() call needed
        // No setMaxListeners needed
    }

    /**
     * Adds a listener for a specific event.
     * @param eventName The name of the event to listen for.
     * @param callback The function to call when the event is emitted.
     * @returns A cleanup function that, when called, removes this specific listener.
     */
    public addListener(eventName: string, callback: EventListenerCallback): CleanupFunction {
        if (!this.listeners.has(eventName)) {
            this.listeners.set(eventName, new Set());
        }
        const listenerSet = this.listeners.get(eventName)!; // Assert non-null as we just set it if needed

        if (listenerSet.has(callback)) {
            logger.warn(`[EventManager] Listener already registered for event "${eventName}".`);
            // Return a no-op cleanup function or the original cleanup?
            // For simplicity, return a new cleanup function that will work.
        }

        listenerSet.add(callback);
        logger.debug(`[EventManager] Listener added for event "${eventName}". Count: ${listenerSet.size}`);

        // Return cleanup function specific to this listener instance
        const cleanup = () => {
            if (this.listeners.has(eventName)) {
                const currentSet = this.listeners.get(eventName)!;
                if (currentSet.delete(callback)) {
                    logger.debug(`[EventManager] Listener removed for event "${eventName}". Remaining: ${currentSet.size}`);
                }
                // If the set becomes empty, remove the event entry itself to keep the map clean
                if (currentSet.size === 0) {
                    this.listeners.delete(eventName);
                    logger.debug(`[EventManager] No listeners remaining for event "${eventName}", removing entry.`);
                }
            }
        };

        return cleanup;
    }

    /**
     * Emits an event to all registered listeners for that event name.
     * This method should be called when an event needs to be dispatched.
     * @param eventName The name of the event to emit.
     * @param args Arguments to pass to the listener callbacks.
     */
    public emitEvent(eventName: string, ...args: any[]): void {
        if (this.listeners.has(eventName)) {
            const listenerSet = this.listeners.get(eventName)!;
            logger.debug(`[EventManager] Emitting event "${eventName}" to ${listenerSet.size} listener(s).`);
            // Iterate over a copy of the set in case a listener modifies the set during iteration
            [...listenerSet].forEach(callback => {
                try {
                    callback(...args);
                } catch (error: any) {
                    logger.error(`[EventManager] Error in listener for event "${eventName}": ${error.message}`, error);
                    // Decide if we should remove the faulty listener? For now, just log.
                }
            });
        } else {
            logger.debug(`[EventManager] No listeners registered for event "${eventName}".`);
        }
    }

    /**
     * Removes all listeners for a specific event, or all listeners entirely.
     * @param eventName Optional. If provided, removes all listeners for this event.
     *                  If omitted, removes all listeners for all events.
     */
    public removeAllListeners(eventName?: string): void {
        if (eventName) {
            if (this.listeners.delete(eventName)) {
                logger.debug(`[EventManager] Removed all listeners for event "${eventName}".`);
            }
        } else {
            this.listeners.clear();
            logger.debug('[EventManager] Removed all listeners for all events.');
        }
        // Note: This doesn't call the individual cleanup functions returned by addListener.
        // It's a more forceful cleanup, typically used during shutdown.
    }

    /**
     * Cleans up all resources, removing all listeners.
     */
    public destroy(): void {
        this.removeAllListeners(); // Remove all listeners
        logger.info('[EventManager] Destroyed.');
    }
}
