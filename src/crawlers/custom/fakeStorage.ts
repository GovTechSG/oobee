export function fakeStorage() {
  const fakeLocalStorage = (function () {
    let store = {};

    return {
      getItem(key) {
        return store[key] || null;
      },
      setItem(key, value) {
        store[key] = String(value);
      },
      removeItem(key) {
        delete store[key];
      },
      clear() {
        store = {};
      },
    };
  })();

  const fakeSessionStorage = (function () {
    let store = {};

    return {
      getItem(key) {
        return store[key] || null;
      },
      setItem(key, value) {
        store[key] = String(value);
      },
      removeItem(key) {
        delete store[key];
      },
      clear() {
        store = {};
      },
    };
  })();
  // Replace the global localStorage with the fake one (for testing):
  Object.defineProperty(window, 'localStorage', {
    value: fakeLocalStorage,
    writable: true, // Important for resetting it later
  });
  Object.defineProperty(window, 'sessionStorage', {
    value: fakeSessionStorage,
    writable: true, // Important for resetting it later
  });
}
