// Shared process lifecycle flag, read by long-running loops and the health endpoint.
export const lifecycle = { shuttingDown: false };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
