'use strict';

// Real ICE/DTLS/SRTP + decoding check. Captures synthetic video/audio only.
// CHROMIUM_EXECUTABLE must point to a Chromium/Chrome headless executable.
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const sessionId = 'native-media-smoke';
const helperPath = process.env.HAVEN_SCREEN_SHARE_HELPER || path.join(
  __dirname, '../native/build/Release',
  process.platform === 'win32' ? 'haven_screen_share.exe' : 'haven_screen_share'
);

const page = `<!doctype html><video autoplay muted></video><script>
const sessionId = ${JSON.stringify(sessionId)};
const pc = new RTCPeerConnection({iceServers: []});
const pendingIce = [];
let remoteSet = false;
let commandNumber = 0;
const command = (cmd, fields) => fetch('/command', {
  method: 'POST', body: JSON.stringify({cmd, fields})
});
pc.onicecandidate = e => {
  if (!e.candidate) return;
  const c = e.candidate;
  command('ICE', [sessionId, '1', c.candidate, c.sdpMid, c.sdpMLineIndex,
    c.usernameFragment, '0', 'media-ice-' + ++commandNumber]);
};
pc.ontrack = e => {
  if (e.track.kind === 'video') document.querySelector('video').srcObject = new MediaStream([e.track]);
};
async function run() {
  await fetch('/start', {method: 'POST'});
  for (let iteration = 0; iteration < 240; iteration++) {
    const events = await (await fetch('/events')).json();
    for (const {event, fields: f} of events) {
      if (event === 'ERROR') throw new Error(f[2]);
      if (event === 'COMMAND_RESULT' && f[3] !== '1') throw new Error(f[4]);
      if (event === 'READY') await command('ADD_PEER', [sessionId, '1', 'media-add-peer']);
      if (event === 'OFFER') {
        await pc.setRemoteDescription({type: 'offer', sdp: f[2]});
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await command('REMOTE_DESCRIPTION', [sessionId, '1', 'answer', answer.sdp, 'media-answer']);
        remoteSet = true;
        for (const candidate of pendingIce.splice(0)) await pc.addIceCandidate(candidate);
      }
      if (event === 'ICE' && f[2]) {
        const candidate = {candidate: f[2], sdpMLineIndex: Number(f[4])};
        if (remoteSet) await pc.addIceCandidate(candidate);
        else pendingIce.push(candidate);
      }
    }
    const report = [...(await pc.getStats()).values()];
    const video = report.find(x => x.type === 'inbound-rtp' && x.kind === 'video');
    const audio = report.find(x => x.type === 'inbound-rtp' && x.kind === 'audio');
    if (video?.framesDecoded >= 60 && audio?.packetsReceived > 0) {
      await fetch('/result', {method: 'POST', body: JSON.stringify({
        framesDecoded: video.framesDecoded, packetsLost: video.packetsLost,
        videoBytes: video.bytesReceived, audioPackets: audio.packetsReceived
      })});
      pc.close();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('No decoded video/audio within 60 seconds');
}
run().catch(error => fetch('/result', {method: 'POST', body: JSON.stringify({error: String(error)})}));
</script>`;

async function run() {
  const chromium = process.env.CHROMIUM_EXECUTABLE;
  if (!chromium || !fs.existsSync(chromium)) throw new Error('Set CHROMIUM_EXECUTABLE to an installed Chromium/Chrome executable');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-media-smoke-'));
  let child, browser, pcmTimer, deadline, stopping = false;
  let events = [];
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  result.catch(() => {});
  const send = (command, fields) => child.stdin.write(
    [command, ...fields.map(field => Buffer.from(String(field ?? '')).toString('base64'))].join('\t') + '\n'
  );
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(page); }
      if (req.url === '/start' && !child) {
        child = spawn(helperPath, [], {stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true});
        child.on('error', rejectResult);
        child.stdin.on('error', error => { if (!stopping) rejectResult(error); });
        child.stdio[3].on('error', error => { if (!stopping) rejectResult(error); });
        child.stderr.on('data', data => process.stderr.write(data));
        child.on('exit', code => { if (!stopping) rejectResult(new Error('Helper exited early: ' + code)); });
        readline.createInterface({input: child.stdout}).on('line', line => {
          const [event, ...encoded] = line.split('\t');
          events.push({event, fields: encoded.map(field => Buffer.from(field, 'base64').toString())});
        });
        pcmTimer = setInterval(() => {
          if (child.stdio[3].writable) child.stdio[3].write(Buffer.alloc(480 * 4));
        }, 10);
        send('START', [sessionId, 'test', '', 0, 0, 1280, 720, 720, 30, 4000000, 'all', '', '', 'H264', '1']);
      } else if (req.url === '/events') {
        const batch = events; events = [];
        return res.end(JSON.stringify(batch));
      } else if (req.url === '/command' || req.url === '/result') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 262144) throw new Error('Oversized smoke request');
        }
        const data = JSON.parse(body);
        if (req.url === '/command') send(data.cmd, data.fields);
        else if (data.error) rejectResult(new Error(data.error));
        else resolveResult(data);
      }
      res.end('{}');
    } catch (error) { rejectResult(error); res.statusCode = 500; res.end('{}'); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
      '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + profile,
      'http://127.0.0.1:' + server.address().port
    ], {stdio: 'ignore', windowsHide: true});
    browser.on('error', rejectResult);
    browser.on('exit', code => { if (!stopping) rejectResult(new Error('Chromium exited early: ' + code)); });
    deadline = setTimeout(() => rejectResult(new Error('Native media smoke timed out')), 90000);
    const stats = await result;
    console.log('Native media smoke passed:', JSON.stringify(stats));
  } finally {
    stopping = true;
    clearTimeout(deadline);
    clearInterval(pcmTimer);
    const children = [child, browser].filter(Boolean);
    for (const process of children) if (process.exitCode === null) process.kill();
    await Promise.all(children.map(process => process.exitCode !== null ? null : new Promise(resolve => {
      const timer = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 3000);
      process.once('exit', () => { clearTimeout(timer); resolve(); });
    })));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
