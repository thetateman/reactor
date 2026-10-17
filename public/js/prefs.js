// Small per-browser preferences (name, minimap) kept in localStorage. Storage
// can be unavailable (private mode, blocked site data); then settings just
// aren't remembered.

export function loadPref(key, fallback) {
  try {
    return localStorage.getItem(`reactor.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(`reactor.${key}`, value);
  } catch {
    // Not remembered this time.
  }
}
