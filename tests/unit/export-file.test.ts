// @vitest-environment node
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readExportFile } from '../../src/core/import/chatgpt-export/file';

const conversation = { conversation_id: 'a', mapping: {} };

describe('readExportFile', () => {
  it('reads a plain conversations.json', async () => {
    await expect(readExportFile(new Blob([JSON.stringify([conversation])]))).resolves.toEqual([
      conversation,
    ]);
  });

  it('reads conversations.json out of an export .zip, ignoring other files', async () => {
    const zip = zipSync({
      'conversations.json': strToU8(JSON.stringify([conversation])),
      'chat.html': strToU8('<html>'),
      'file-abc.png': new Uint8Array([1, 2, 3]),
    });
    await expect(readExportFile(new Blob([zip]))).resolves.toEqual([conversation]);
  });

  it('concatenates split conversation files in order', async () => {
    const zip = zipSync({
      'conversations-001.json': strToU8(JSON.stringify([{ id: 2 }])),
      'conversations-000.json': strToU8(JSON.stringify([{ id: 1 }])),
    });
    await expect(readExportFile(new Blob([zip]))).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('explains what is wrong with bad input', async () => {
    await expect(readExportFile(new Blob(['{not json']))).rejects.toThrow('not valid JSON');
    await expect(readExportFile(new Blob(['{}']))).rejects.toThrow('array of conversations');
    await expect(readExportFile(new Blob([zipSync({ 'x.txt': strToU8('x') })]))).rejects.toThrow(
      'No conversations.json',
    );
  });
});
