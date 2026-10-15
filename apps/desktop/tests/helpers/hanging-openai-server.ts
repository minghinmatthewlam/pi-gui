import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface HangingOpenAiServer {
  readonly baseUrl: string;
  readonly pendingRequestCount: () => number;
  readonly close: () => Promise<void>;
}

/**
 * An OpenAI-compatible endpoint that accepts every request and never answers, so a
 * model turn stays in flight until the server is closed.
 */
export async function startHangingOpenAiServer(): Promise<HangingOpenAiServer> {
  const pending = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    pending.add(response);
    response.on("close", () => pending.delete(response));
    request.resume();
    // Intentionally leave the response pending.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    pendingRequestCount: () => pending.size,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
