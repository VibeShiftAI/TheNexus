// Some Cast TVs still use Chromium 92. esbuild lowers syntax, not runtime APIs;
// react-markdown needs Object.hasOwn, which first shipped in Chromium 93.
if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true,
    writable: true,
    value: function hasOwn(object: unknown, property: PropertyKey): boolean {
      if (object === null || object === undefined) throw new TypeError('Cannot convert undefined or null to object');
      return Object.prototype.hasOwnProperty.call(object, property);
    },
  });
}
