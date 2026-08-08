/// <reference lib="webworker" />

import {
  createFrameDecoderWorkerHandler,
  type FrameDecoderWorkerRequest,
} from "./desktopStreamFrameDecoder.workerProtocol";

declare const self: DedicatedWorkerGlobalScope;

const handleMessage = createFrameDecoderWorkerHandler((message, transfer = []) => {
  self.postMessage(message, transfer);
});

self.onmessage = (event: MessageEvent<FrameDecoderWorkerRequest>) => {
  handleMessage(event.data);
};

export {};
