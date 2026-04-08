/**
 * Socket.io Singleton
 * 
 * Exports a holder object so route modules can access io.get()
 * AFTER the server has initialized it in server.js.
 * 
 * Usage in route modules:
 *   const ioHolder = require('../shared/io');
 *   ioHolder.get().emit('event', data);
 */

let _io = null;

module.exports = {
    /** Called once from server.js after creating the Socket.io Server */
    set(io) {
        _io = io;
    },

    /** Returns the Socket.io Server instance (throws if not yet initialized) */
    get() {
        if (!_io) {
            throw new Error('[shared/io] Socket.io not initialized yet — call set(io) first');
        }
        return _io;
    },

    /** Safe check — returns io or null without throwing */
    getSafe() {
        return _io;
    }
};
