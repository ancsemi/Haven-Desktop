'use strict';

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const HELPER = process.env.HAVEN_SCREEN_SHARE_HELPER || path.join(
  ROOT,
  'native',
  'build',
  'Release',
  process.platform === 'win32' ? 'haven_screen_share.exe' : 'haven_screen_share'
);
const SESSION_ID = 'native-smoke-session';

function encodeField(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function decodeField(value) {
  return Buffer.from(String(value || ''), 'base64').toString('utf8');
}

function send(child, command, fields) {
  child.stdin.write([command, ...fields.map(encodeField)].join('\t') + '\n');
}

async function run() {
  const child = spawn(HELPER, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  await new Promise((resolve, reject) => {
    let ready = false;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      if (error) {
        try { child.kill(); } catch {}
        reject(error);
      } else {
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Native screen smoke test timed out${stderr ? `: ${stderr.trim()}` : ''}`));
    }, 60000);
    const lines = readline.createInterface({ input: child.stdout });

    child.once('error', finish);
    child.once('exit', code => {
      if (settled) return;
      if (code === 0 && ready) finish();
      else finish(new Error(
        `Native screen helper exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`
      ));
    });
    lines.on('line', line => {
      const [event, ...encodedFields] = line.split('\t');
      const fields = encodedFields.map(decodeField);
      if (fields[0] !== SESSION_ID) return;
      if (event === 'READY' && !ready) {
        const softwareExpected = process.env.HAVEN_NATIVE_FORCE_SOFTWARE === '1';
        if (!fields[1] || !['0', '1'].includes(fields[2])) {
          finish(new Error('Native screen helper returned no encoder metadata'));
          return;
        }
        if (softwareExpected && fields[2] !== '0') {
          finish(new Error(`Expected a software encoder, got ${fields[1]}`));
          return;
        }
        ready = true;
        send(child, 'STOP', [SESSION_ID]);
      } else if (event === 'STOPPED' && ready) {
        finish();
      } else if (event === 'ERROR') {
        finish(new Error(fields[2] || 'Native screen helper reported an error'));
      }
    });

    send(child, 'START', [
      SESSION_ID,
      'test',
      '',
      0,
      0,
      1280,
      720,
      720,
      30,
      4000000,
      'all',
      '',
      '',
      'H264',
      '0',
    ]);
  });

  console.log('Native screen smoke test passed: encoded H.264 RTP reached the readiness sink.');
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
