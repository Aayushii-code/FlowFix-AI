/**
 * Server-Sent Events parser for TinyFish's /v1/automation/run-sse stream.
 *
 * Implements the WHATWG SSE parsing rules that matter here:
 *  - events are separated by a blank line (\n\n or \r\n\r\n)
 *  - "data:" lines accumulate (multiple data lines join with \n)
 *  - "event:", "id:", "retry:" fields are recognised
 *  - comment lines (": ...") are ignored
 *  - chunks may split events at arbitrary byte boundaries; state is buffered
 *
 * TinyFish sends one JSON object per data line:
 *   data: {"type":"STARTED","run_id":"abc123","timestamp":"..."}
 */

/** Find the next event boundary; returns {start, end} slice bounds or null. */
function findBoundary(buffer) {
  let idx = buffer.indexOf('\n\n');
  let len = 2;
  const crlf = buffer.indexOf('\r\n\r\n');
  if (crlf !== -1 && (idx === -1 || crlf < idx)) {
    idx = crlf;
    len = 4;
  }
  if (idx === -1) return null;
  return { start: idx, end: idx + len };
}

/** Parse one raw event block into { event, data, json?, raw } or null. */
function parseEventBlock(block) {
  const dataLines = [];
  let eventName = 'message';
  let lastId = null;

  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue; // blank or comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        lastId = value;
        break;
      case 'retry':
        break;
      default:
        break; // unknown fields per spec are ignored
    }
  }

  if (dataLines.length === 0) return null;

  const data = dataLines.join('\n');
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    json = undefined; // non-JSON data is legal SSE; caller sees raw
  }
  return { event: eventName, data, json, id: lastId };
}

export class SseParser {
  constructor() {
    this.buffer = '';
  }

  /**
   * Feed a decoded text chunk; returns every complete event found so far.
   * Safe to call with empty strings (used to flush at stream end).
   */
  push(chunk) {
    if (chunk) this.buffer += chunk;
    const events = [];
    let boundary;
    while ((boundary = findBoundary(this.buffer)) !== null) {
      const block = this.buffer.slice(0, boundary.start);
      this.buffer = this.buffer.slice(boundary.end);
      const parsed = parseEventBlock(block);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  /** Flush any trailing data that arrived without a final blank line. */
  flush() {
    const events = [];
    if (this.buffer.trim().length > 0) {
      const parsed = parseEventBlock(this.buffer);
      if (parsed) events.push(parsed);
      this.buffer = '';
    }
    return events;
  }
}

/** Convenience: parse a full SSE text document (used in tests). */
export function parseSseText(text) {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.flush()];
}
