// Desktop and browser builds. Android builds replace this module with
// ./index.ts (vite.config.ts), so the Android bridge never reaches them.
const missing = () => Promise.reject(Error('Not available in this build'));
export const isAndroid = false;
export const call = <T = any>(_command: string, _args?: Record<string, unknown>): Promise<T> =>
  missing();
export const startMobile = (): Promise<void> => missing();
export const saveFile = (_blob: Blob, _name: string): Promise<void> => missing();
export const openExternal = (_url: string): Promise<void> => missing();
export const onAndroidLifecycle = (_flush: () => Promise<void>) => () => {};
