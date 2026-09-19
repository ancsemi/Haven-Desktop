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
const REMOTE_ICE_UFRAG = 'havenSmoke';
const REMOTE_ICE_PWD = 'havenNativeSmokeRemotePassword1234';
const REMOTE_FINGERPRINT = [
  '11', '22', '33', '44', '55', '66', '77', '88',
  '99', 'AA', 'BB', 'CC', 'DD', 'EE', 'FF', '00',
  '10', '20', '30', '40', '50', '60', '70', '80',
  '90', 'A0', 'B0', 'C0', 'D0', 'E0', 'F0', '01',
].join(':');

function encodeField(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function decodeField(value) {
  return Buffer.from(String(value || ''), 'base64').toString('utf8');
}

function send(child, command, fields) {
  child.stdin.write([command, ...fields.map(encodeField)].join('\t') + '\n');
}

function buildRemoteAnswer(offer) {
  const lines = offer.split(/\r?\n/);
  const answer = [];
  for (const line of lines) {
    if (/^a=(?:candidate|end-of-candidates|ssrc|ssrc-group|msid|msid-semantic):/.test(line)) {
      continue;
    }
    if (line.startsWith('o=')) answer.push('o=haven-smoke 1 1 IN IP4 127.0.0.1');
    else if (line.startsWith('a=ice-ufrag:')) answer.push(`a=ice-ufrag:${REMOTE_ICE_UFRAG}`);
    else if (line.startsWith('a=ice-pwd:')) answer.push(`a=ice-pwd:${REMOTE_ICE_PWD}`);
    else if (line.startsWith('a=fingerprint:')) {
      answer.push(`a=fingerprint:sha-256 ${REMOTE_FINGERPRINT}`);
    } else if (line === 'a=setup:actpass') answer.push('a=setup:active');
    else if (line === 'a=sendonly' || line === 'a=sendrecv') answer.push('a=recvonly');
    else answer.push(line);
  }
  return answer.join('\r\n');
}

async function run() {
  const child = spawn(HELPER, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  await new Promise((resolve, reject) => {
    let ready = false;
    let stopped = false;
    let receivedOffer = false;
    let receivedIceCandidate = false;
    let receivedIceComplete = false;
    let peerAcknowledged = false;
    let remoteDescriptionAcknowledged = false;
    let remoteIceAcknowledged = false;
    let remoteDescriptionRequested = false;
    let stopRequested = false;
    let settled = false;
    let encoder = '';
    let offerSdp = '';
    let phase = 'startup';
    let timeout;
    let pcmTimer;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(pcmTimer);
      try { child.stdio[3].end(); } catch {}
      lines.close();
      if (error) {
        try { child.kill(); } catch {}
        reject(error);
      } else {
        resolve();
      }
    };
    const continuePeerHandshake = () => {
      if (stopRequested || !peerAcknowledged || !receivedOffer ||
          !receivedIceCandidate || !receivedIceComplete) return;
      if (!remoteDescriptionRequested) {
        remoteDescriptionRequested = true;
        send(child, 'REMOTE_DESCRIPTION', [
          SESSION_ID,
          '1',
          'answer',
          buildRemoteAnswer(offerSdp),
          'native-smoke-answer',
        ]);
        armTimeout('remote description', 10000);
        return;
      }
      if (!remoteDescriptionAcknowledged || !remoteIceAcknowledged) return;
      stopRequested = true;
      send(child, 'STOP', [SESSION_ID]);
      armTimeout('teardown', 10000);
    };
    const armTimeout = (nextPhase, duration) => {
      phase = nextPhase;
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const details = [
          `phase=${phase}`,
          encoder ? `encoder=${encoder}` : '',
          stderr.trim(),
        ].filter(Boolean).join(', ');
        finish(new Error(`Native screen smoke test timed out (${details})`));
      }, duration);
    };
    const lines = readline.createInterface({ input: child.stdout });

    child.once('error', finish);
    child.stdio[3].on('error', error => {
      if (!stopRequested) finish(error);
    });
    child.once('exit', code => {
      if (settled) return;
      if (code === 0 && ready && peerAcknowledged && receivedOffer &&
          receivedIceCandidate && receivedIceComplete &&
          remoteDescriptionAcknowledged && remoteIceAcknowledged && stopped) finish();
      else finish(new Error(
        `Native screen helper exited with code ${code} during ${phase}` +
        `${encoder ? ` using ${encoder}` : ''}${stderr ? `: ${stderr.trim()}` : ''}`
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
        encoder = fields[1];
        armTimeout('peer negotiation', 30000);
        send(child, 'ADD_PEER', [SESSION_ID, '1', 'native-smoke-peer']);
      } else if (event === 'COMMAND_RESULT' && fields[1] === 'native-smoke-peer' &&
                 fields[2] === 'ADD_PEER') {
        if (fields[3] !== '1') {
          finish(new Error(fields[4] || 'Native screen helper rejected the smoke peer'));
          return;
        }
        peerAcknowledged = true;
        continuePeerHandshake();
      } else if (event === 'COMMAND_RESULT' && fields[1] === 'native-smoke-answer' &&
                 fields[2] === 'REMOTE_DESCRIPTION') {
        if (fields[3] !== '1') {
          finish(new Error(fields[4] || 'Native screen helper rejected the smoke answer'));
          return;
        }
        remoteDescriptionAcknowledged = true;
        send(child, 'ICE', [
          SESSION_ID,
          '1',
          `candidate:1 1 UDP 2122260223 127.0.0.1 50000 typ host generation 0 ufrag ${REMOTE_ICE_UFRAG}`,
          offerSdp.match(/^a=mid:(.+)$/m)?.[1]?.trim() || '',
          '0',
          REMOTE_ICE_UFRAG,
          '0',
          'native-smoke-ice',
        ]);
        armTimeout('remote ICE', 10000);
      } else if (event === 'COMMAND_RESULT' && fields[1] === 'native-smoke-ice' &&
                 fields[2] === 'ICE') {
        if (fields[3] !== '1') {
          finish(new Error(fields[4] || 'Native screen helper rejected remote smoke ICE'));
          return;
        }
        remoteIceAcknowledged = true;
        continuePeerHandshake();
      } else if (event === 'OFFER' && ready && fields[1] === '1') {
        if (!fields[2]?.includes('m=video') || !fields[2]?.includes('m=audio')) {
          finish(new Error('Native screen helper offer did not contain video and audio media'));
          return;
        }
        offerSdp = fields[2];
        receivedOffer = true;
        continuePeerHandshake();
      } else if (event === 'ICE' && ready && fields[1] === '1') {
        if (fields[6] === '1') receivedIceComplete = true;
        else if (fields[2]) receivedIceCandidate = true;
        continuePeerHandshake();
      } else if (event === 'STOPPED' && ready) {
        stopped = true;
        armTimeout('exit', 5000);
      } else if (event === 'ERROR') {
        finish(new Error(
          `${fields[2] || 'Native screen helper reported an error'} (phase=${phase}` +
          `${stderr.trim() ? `, ${stderr.trim()}` : ''})`
        ));
      }
    });

    armTimeout('startup', 60000);
    pcmTimer = setInterval(() => {
      if (!child.stdio[3].writable) return;
      child.stdio[3].write(Buffer.alloc(480 * Float32Array.BYTES_PER_ELEMENT));
    }, 10);
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
      '1',
    ]);
  });

  console.log('Native screen smoke test passed: outbound signaling, inbound signaling ingestion, and clean shutdown verified.');
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
