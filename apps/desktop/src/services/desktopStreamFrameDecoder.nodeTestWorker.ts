import { parentPort } from "node:worker_threads";
import {
  createFrameDecoderWorkerHandler,
  type FrameDecoderWorkerRequest,
} from "./desktopStreamFrameDecoder.workerProtocol.ts";

const port = parentPort;
if (!port) throw new Error("decoder test worker has no parent port");

const handleMessage = createFrameDecoderWorkerHandler((message, transfer = []) => {
  port.postMessage(message, transfer as ArrayBuffer[]);
});

port.on("message", (message: FrameDecoderWorkerRequest) => {
  handleMessage(message);
});
