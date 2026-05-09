const KEY = 'pharos-username';

export function getUserName() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setUserName(name) {
  try {
    localStorage.setItem(KEY, name);
  } catch {}
}
