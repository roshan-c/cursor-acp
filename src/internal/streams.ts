export function nodeToWebReadable(nodeStdin: NodeJS.ReadStream): ReadableStream<Uint8Array> {
  const reader = nodeStdin;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk));
      const onEnd = () => controller.close();
      const onError = (err: unknown) => controller.error(err);
      reader.on("data", onData);
      reader.once("end", onEnd);
      reader.once("error", onError);
    },
  });
}

export function nodeToWebWritable(nodeStdout: NodeJS.WriteStream): WritableStream<Uint8Array> {
  const writer = nodeStdout;
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        writer.write(Buffer.from(chunk), (err?: Error | null) => (err ? reject(err) : resolve()));
      });
    },
    close() {},
    abort() {},
  });
}
