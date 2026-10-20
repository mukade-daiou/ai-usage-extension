import type { ExtensionMessage } from '../shared/types';

const TOKEN_KEYS = ['z-ai-open-platform-token-production', 'z-ai-website-token'];

const PUBLISH_DELAYS_MS = [0, 1_000, 3_000, 10_000, 30_000];

let lastPublished: string | null = null;
let lastObserved: string | null = null;
let publishRevision = 0;
let clearTimer: number | undefined;

const readToken = (): string | null | undefined => {
  for (const key of TOKEN_KEYS) {
    try {
      const value = window.localStorage.getItem(key)?.trim();
      if (value) return value;
    } catch {
      return undefined;
    }
  }
  return null;
};

const sendToken = (token: string | null, removedToken = lastPublished): void => {
  const previous = lastPublished;
  if (token === previous && !(token === null && removedToken)) return;
  const revision = ++publishRevision;
  lastPublished = token;
  const message: ExtensionMessage = token
    ? { type: 'SET_GLM_TOKEN', token }
    : { type: 'CLEAR_GLM_TOKEN', token: removedToken! };
  const retry = (): void => {
    if (revision !== publishRevision) return;
    lastPublished = previous;
    if (token === null && lastObserved === null) lastObserved = removedToken;
  };
  try {
    void chrome.runtime
      .sendMessage(message)
      .then((response) => {
        if (!response?.success) retry();
      })
      .catch(retry);
  } catch {
    retry();
  }
};

const publishToken = (): void => {
  const token = readToken();
  if (token === undefined) return;
  if (token) {
    lastObserved = token;
    window.clearTimeout(clearTimer);
    clearTimer = undefined;
    sendToken(token);
  } else if (lastObserved && clearTimer === undefined) {
    // Ignore initial empty storage and brief remove/set transitions.
    clearTimer = window.setTimeout(() => {
      clearTimer = undefined;
      if (readToken() === null) {
        const removed = lastObserved;
        lastObserved = null;
        sendToken(null, removed);
      }
    }, 1_000);
  }
};

for (const delay of PUBLISH_DELAYS_MS) {
  window.setTimeout(publishToken, delay);
}

window.addEventListener('storage', publishToken);
// Same-document localStorage writes do not emit a storage event in this tab.
window.setInterval(publishToken, 3_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') publishToken();
});
