import { createConnection } from "node:net";

/** The probe must not silently attach its QA runner to an older Electron on the same CDP port. */
export async function assertQaCdpPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(
        new Error(
          `QA CDP port ${port} already in use; stop the existing isolated probe or choose a different port`,
        ),
      );
    });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}
