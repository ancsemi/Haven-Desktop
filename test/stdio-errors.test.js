'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handleClosedOutput } = require('../src/main/stdio-errors');

test('a closed launcher output pipe does not become an uncaught exception', () => {
  const stream = new EventEmitter();
  handleClosedOutput(stream);
  assert.doesNotThrow(() => stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
  const error = Object.assign(new Error('unexpected I/O error'), { code: 'EIO' });
  assert.throws(() => stream.emit('error', error), error);
});
