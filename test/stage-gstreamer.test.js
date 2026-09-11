'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LINUX_REQUIRED_PLUGIN_GROUPS,
  WINDOWS_REQUIRED_PLUGIN_GROUPS,
  selectLinuxEncoderPlugins,
  selectRequiredPlugins,
} = require('../scripts/stage-gstreamer');

test('accepts split videoconvert and videoscale plugins used by Ubuntu 22.04', () => {
  const plugins = [
    '/usr/lib/gstreamer-1.0/libgstvideoconvert.so',
    '/usr/lib/gstreamer-1.0/libgstvideoscale.so',
  ];

  assert.deepEqual(selectRequiredPlugins(plugins, [
    ['libgstvideoconvertscale.so', 'libgstvideoconvert.so'],
    ['libgstvideoconvertscale.so', 'libgstvideoscale.so'],
  ]), plugins);
});

test('accepts the combined videoconvertscale plugin without staging it twice', () => {
  const combined = '/opt/gstreamer/libgstvideoconvertscale.so';
  const selected = selectRequiredPlugins([combined], [
    ['libgstvideoconvertscale.so', 'libgstvideoconvert.so'],
    ['libgstvideoconvertscale.so', 'libgstvideoscale.so'],
  ]);

  assert.deepEqual([...new Set(selected)], [combined]);
});

test('does not accept Rust RTP plugins in place of the required C transport plugins', () => {
  const plugins = [
    '/opt/gstreamer/libgstrsrtp.so',
    '/opt/gstreamer/libgstrswebrtc.so',
  ];

  assert.throws(
    () => selectRequiredPlugins(plugins, [['libgstrtp.so']]),
    /libgstrtp\.so/
  );
  assert.throws(
    () => selectRequiredPlugins(plugins, [['libgstwebrtc.so']]),
    /libgstwebrtc\.so/
  );
});

test('staged runtimes require the appsrc plugin used by native audio', () => {
  assert.equal(
    LINUX_REQUIRED_PLUGIN_GROUPS.some(group => group.includes('libgstapp.so')),
    true
  );
  assert.equal(
    WINDOWS_REQUIRED_PLUGIN_GROUPS.some(group => group.includes('gstapp.dll')),
    true
  );
});

test('staged runtimes require the test source used for encoder preflight', () => {
  assert.equal(
    LINUX_REQUIRED_PLUGIN_GROUPS.some(group => group.includes('libgstvideotestsrc.so')),
    true
  );
  assert.equal(
    WINDOWS_REQUIRED_PLUGIN_GROUPS.some(group => group.includes('gstvideotestsrc.dll')),
    true
  );
});

test('staged runtimes require an H.264 software fallback', () => {
  assert.equal(
    LINUX_REQUIRED_PLUGIN_GROUPS.some(group =>
      group.includes('libgstx264.so') && group.includes('libgstopenh264.so')),
    true
  );
  assert.equal(
    WINDOWS_REQUIRED_PLUGIN_GROUPS.some(group =>
      group.includes('gstx264.dll') && group.includes('gstopenh264.dll')),
    true
  );
});

test('Linux staging keeps every available hardware and software encoder plugin', () => {
  const plugins = [
    '/opt/gstreamer/libgstva.so',
    '/opt/gstreamer/libgstx264.so',
    '/opt/gstreamer/libgstopenh264.so',
    '/opt/gstreamer/libgstcoreelements.so',
  ];

  assert.deepEqual(selectLinuxEncoderPlugins(plugins), plugins.slice(0, 3));
});
