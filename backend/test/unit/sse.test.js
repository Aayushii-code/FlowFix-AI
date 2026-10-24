/**
 * SSE parser unit tests: chunk-boundary safety, comment/heartbeat handling,
 * multi-line data, CRLF, flush of unterminated tails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, parseSseText } from '../../src/tinyfish/sse.js';

test('parses a single well-formed event', () => {
  const events = parseSseText('data: {"type":"STARTED","run_id":"r1"}\n\n');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].json, { type: 'STARTED', run_id: 'r1' });
  assert.equal(events[0].event, 'message');
});

test('parses multiple events in one chunk', () => {
  const text =
    'data: {"type":"STARTED","run_id":"r1"}\n\n' +
    'data: {"type":"PROGRESS","purpose":"click"}\n\n' +
    'data: {"type":"COMPLETE","status":"COMPLETED"}\n\n';
  const events = parseSseText(text);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.json.type), ['STARTED', 'PROGRESS', 'COMPLETE']);
});

test('handles events split across arbitrary chunk boundaries', () => {
  const parser = new SseParser();
  const full = 'data: {"type":"PROGRESS","run_id":"r1","purpose":"Extract product names"}\n\ndata: {"type":"COMPLETE","status":"COMPLETED","result":{"ok":true}}\n\n';
  const collected = [];

  // Feed one character at a time — worst-case fragmentation.
  for (const ch of full) {
    collected.push(...parser.push(ch));
  }
  collected.push(...parser.flush());

  assert.equal(collected.length, 2);
  assert.equal(collected[0].json.purpose, 'Extract product names');
  assert.equal(collected[1].json.status, 'COMPLETED');
});

test('handles CRLF line endings', () => {
  const events = parseSseText('data: {"type":"STARTED","run_id":"r1"}\r\n\r\ndata: {"type":"COMPLETE","status":"COMPLETED"}\r\n\r\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].json.type, 'STARTED');
});

test('ignores comment lines (heartbeats)', () => {
  const events = parseSseText(': heartbeat\n\ndata: {"type":"STARTED","run_id":"r1"}\n\n: heartbeat\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].json.type, 'STARTED');
});

test('joins multiple data lines with newline', () => {
  const events = parseSseText('data: {"a":\ndata: 1}\n\n');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].json, { a: 1 });
  assert.equal(events[0].data, '{"a":\n1}');
});

test('passes through non-JSON data as raw', () => {
  const events = parseSseText('data: plain text not json\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].json, undefined);
  assert.equal(events[0].data, 'plain text not json');
});

test('flush emits an unterminated final event (stream cut before blank line)', () => {
  const parser = new SseParser();
  const events = parser.push('data: {"type":"COMPLETE","status":"COMPLETED"}\n');
  assert.equal(events.length, 0); // boundary not seen yet
  const flushed = parser.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].json.status, 'COMPLETED');
});

test('honours event: field names', () => {
  const events = parseSseText('event: custom\ndata: {"x":1}\n\n');
  assert.equal(events[0].event, 'custom');
});

test('empty pushes are no-ops', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(''), []);
  assert.deepEqual(parser.push(undefined), []);
  assert.deepEqual(parser.flush(), []);
});
