import type { PiDesktopApi } from "../contracts/ipc";

export {};

declare global {
  interface Window {
    piApp?: PiDesktopApi;
  }
}
