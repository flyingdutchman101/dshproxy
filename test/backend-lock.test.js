'use strict';
// The shipped lock names the official download for both systems and both
// processors, each with the checksum the release publishes (spec 0014, C3).
const test = require('node:test');
const assert = require('node:assert/strict');

const lock = require('../backend.lock.json');
const { assetFor } = require('../src/backend/install');

// The lines of `checksums.txt` of release v8.1.4 for these four archives, as
// fetched from the release on 23 Nov 2026.
const CHECKSUMS_8_1_4 = `
9d9e2350d4af9c2cd1c3636a5892e3b669829284f3a54b252fe1bdfb6b49d93a  CLIProxyAPI_8.1.4_darwin_aarch64.tar.gz
733f276d73df67724f5dee338a0e8db552d308525d27e614984b372061aec37f  CLIProxyAPI_8.1.4_darwin_amd64.tar.gz
7fe1c3259c88e9bd0b4a7dfdad67105a1dc43ddca0896ce94c7d648ec1364713  CLIProxyAPI_8.1.4_windows_aarch64.zip
665b670d42a5ceeadd33a6f03dffaa362cde920b726ab6b117c4def94ff81b09  CLIProxyAPI_8.1.4_windows_amd64.zip
`;

const EXPECTED = {
  'win32-x64': 'CLIProxyAPI_8.1.4_windows_amd64.zip',
  'win32-arm64': 'CLIProxyAPI_8.1.4_windows_aarch64.zip',
  'darwin-arm64': 'CLIProxyAPI_8.1.4_darwin_aarch64.tar.gz',
  'darwin-x64': 'CLIProxyAPI_8.1.4_darwin_amd64.tar.gz'
};

test('the shipped lock has the four official archives, each with the checksum the release published', () => {
  assert.equal(lock.version, '8.1.4');
  const sums = new Map(CHECKSUMS_8_1_4.trim().split('\n').map((line) => line.split(/\s+/).reverse()));
  assert.deepEqual(Object.keys(lock.assets).sort(), Object.keys(EXPECTED).sort());
  for (const [key, name] of Object.entries(EXPECTED)) {
    assert.equal(lock.assets[key].url, `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.1.4/${name}`, key);
    assert.equal(lock.assets[key].sha256, sums.get(name), key);
  }
});

test('a Mac with either processor finds its download in the shipped lock', () => {
  assert.match(assetFor(lock, 'darwin', 'arm64').url, /darwin_aarch64\.tar\.gz$/);
  assert.match(assetFor(lock, 'darwin', 'x64').url, /darwin_amd64\.tar\.gz$/);
  assert.match(assetFor(lock, 'win32', 'x64').url, /windows_amd64\.zip$/);
});
