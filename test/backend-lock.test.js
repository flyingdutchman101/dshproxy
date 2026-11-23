'use strict';
// The shipped lock names the official download for both systems and both
// processors, each with the checksum the release publishes (spec 0014, C3).
const test = require('node:test');
const assert = require('node:assert/strict');

const lock = require('../backend.lock.json');
const { assetFor } = require('../src/backend/install');

// The lines of `checksums.txt` of release v8.0.72 for these four archives, as
// fetched from the release on 23 Nov 2026.
const CHECKSUMS_8_0_72 = `
ae008afd4ad52603f220200afc6417102591ba0a847d128cb65e904f86ac7918  CLIProxyAPI_8.0.72_darwin_aarch64.tar.gz
27591f4c829cd3a2ce9daed541328103f6439841d25aefca82207d79126a90af  CLIProxyAPI_8.0.72_darwin_amd64.tar.gz
07666c498620f3f2825c30e9ff1b1b3b10abe6d00a998c9f8b59d437ed9bf225  CLIProxyAPI_8.0.72_windows_aarch64.zip
9c98651a4a35e05fd87193bf722710f32ff87d13ff8b7177d0cfd200f4b51749  CLIProxyAPI_8.0.72_windows_amd64.zip
`;

const EXPECTED = {
  'win32-x64': 'CLIProxyAPI_8.0.72_windows_amd64.zip',
  'win32-arm64': 'CLIProxyAPI_8.0.72_windows_aarch64.zip',
  'darwin-arm64': 'CLIProxyAPI_8.0.72_darwin_aarch64.tar.gz',
  'darwin-x64': 'CLIProxyAPI_8.0.72_darwin_amd64.tar.gz'
};

test('the shipped lock has the four official archives, each with the checksum the release published', () => {
  assert.equal(lock.version, '8.0.72');
  const sums = new Map(CHECKSUMS_8_0_72.trim().split('\n').map((line) => line.split(/\s+/).reverse()));
  assert.deepEqual(Object.keys(lock.assets).sort(), Object.keys(EXPECTED).sort());
  for (const [key, name] of Object.entries(EXPECTED)) {
    assert.equal(lock.assets[key].url, `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.72/${name}`, key);
    assert.equal(lock.assets[key].sha256, sums.get(name), key);
  }
});

test('a Mac with either processor finds its download in the shipped lock', () => {
  assert.match(assetFor(lock, 'darwin', 'arm64').url, /darwin_aarch64\.tar\.gz$/);
  assert.match(assetFor(lock, 'darwin', 'x64').url, /darwin_amd64\.tar\.gz$/);
  assert.match(assetFor(lock, 'win32', 'x64').url, /windows_amd64\.zip$/);
});
