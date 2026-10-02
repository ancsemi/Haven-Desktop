'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { isTrustedMainFrame } = require('../src/main/ipc-security');

const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8').replace(/\r\n/g, '\n');
const start = main.indexOf('  session.defaultSession.setDisplayMediaRequestHandler(');
const end = main.indexOf('\n  });\n}', start) + '\n  });'.length;

for (const platform of ['win32', 'linux']) {
  test(`display capture resolves the requesting WebContents on ${platform}`, async () => {
    const frame = { url: 'https://haven.example/app.html', isDestroyed: () => false };
    const owner = { mainFrame: frame, getURL: () => frame.url };
    const source = { id: 'screen:0:0', name: 'Display', display_id: '1' };
    let handler;
    let pickerCalls = 0;
    const context = {
      session: { defaultSession: { setDisplayMediaRequestHandler: fn => { handler = fn; } } },
      webContents: { fromFrame: candidate => candidate === frame ? owner : null },
      getTrustedServerUrlForFrame: (contents, candidate) =>
        isTrustedMainFrame(contents, candidate, 'https://haven.example'),
      screenShareRequestInProgress: false,
      isWaylandSession: () => false,
      desktopCapturer: { getSources: async () => [source] },
      mainWindow: null,
      audioCapture: { getAudioApplications: () => [], isSupported: () => false },
      process: { platform, pid: 123 },
      store: { get: () => 'auto', set() {} },
      normalizeVideoEncoderPreference: value => value,
      hardwareVideoEncodingAvailable: false,
      hardwareVideoEncodingStatus: '',
      requestScreenPicker: async (contents, data) => {
        assert.equal(contents, owner);
        pickerCalls++;
        return { sourceId: source.id, requestId: data.requestId, audioAppPid: 'none' };
      },
      resolveSelectedSource: async () => source,
      resolveAudioSelection: () => ({ type: 'none', app: null }),
      prepareStandardScreenShare: async () => ({ audioReady: false }),
      safeSend() {},
      console: { log() {}, warn() {}, error: (...args) => { throw new Error(args.join(' ')); } },
    };
    vm.runInNewContext(main.slice(start, end), context);
    let result;
    await handler({ frame }, value => { result = value; });
    assert.equal(pickerCalls, 1);
    assert.equal(result.video, source);
    assert.equal(context.screenShareRequestInProgress, false);

    // A foreign or destroyed frame must still be denied before showing consent.
    await handler({ frame: { ...frame } }, value => { result = value; });
    assert.equal(result.video, undefined);
    frame.isDestroyed = () => true;
    await handler({ frame }, value => { result = value; });
    assert.equal(result.video, undefined);
    assert.equal(pickerCalls, 1);
    await assert.doesNotReject(handler({ frame }, () => {
      throw new TypeError('Video was requested, but no video stream was provided');
    }));
  });
}
