/** Platform-neutral SSE framing shared by provider wires and the browser. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      signal?.throwIfAborted();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const at = buffer.search(/[\r\n]/);
        if (at < 0 || (!chunk.done && buffer[at] === "\r" && at === buffer.length - 1)) break;
        const line = buffer.slice(0, at);
        const width = buffer[at] === "\r" && buffer[at + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(at + width);
        if (!line) {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
        } else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (chunk.done) {
        if (buffer.trim() || data.length) throw new Error("truncated SSE frame");
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
