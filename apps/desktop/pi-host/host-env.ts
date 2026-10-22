/**
 * Imported first by the host, before pi loads: takes the pipe address out of the environment
 * and clears what only this process needs, so tools and extensions pi starts never see them.
 * Electron reads ELECTRON_RUN_AS_NODE only at startup; a child that inherits it would start any
 * Electron app (for example `pnpm dev` run by a tool) as plain Node.
 */
export const PI_HOST_SOCKET_ENV = "PI_GUI_HOST_SOCKET";
export const PI_HOST_TOKEN_ENV = "PI_GUI_HOST_TOKEN";

export const hostSocketPath = process.env[PI_HOST_SOCKET_ENV] ?? "";
export const hostToken = process.env[PI_HOST_TOKEN_ENV] ?? "";
delete process.env[PI_HOST_SOCKET_ENV];
delete process.env[PI_HOST_TOKEN_ENV];
delete process.env.ELECTRON_RUN_AS_NODE;
