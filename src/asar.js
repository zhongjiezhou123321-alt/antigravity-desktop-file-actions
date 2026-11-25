'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_BLOCK_SIZE = 4194304; // 4 MiB, standard Electron ASAR integrity block size

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function align4(n) {
  return (n + 3) & ~3;
}

/**
 * Computes Electron ASAR per-file SHA-256 integrity metadata.
 */
function computeIntegrity(buf, blockSize = DEFAULT_BLOCK_SIZE) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(hash);
  } else {
    for (let offset = 0; offset < buf.length; offset += blockSize) {
      const slice = buf.subarray(offset, Math.min(offset + blockSize, buf.length));
      blocks.push(crypto.createHash('sha256').update(slice).digest('hex'));
    }
  }
  return {
    algorithm: 'SHA256',
    hash,
    blockSize,
    blocks
  };
}

/**
 * Parses an ASAR archive header without extracting all files to disk.
 */
function readAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, sizeBuf, 0, 16, 0);
    if (bytesRead < 16) {
      throw new Error(`Invalid ASAR file (too small): ${asarPath}`);
    }
    const headerPickleSize = sizeBuf.readUInt32LE(4);
    const jsonLen = sizeBuf.readUInt32LE(12);
    const dataOffset = 8 + headerPickleSize;

    const headerBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, headerBuf, 0, jsonLen, 16);
    const header = JSON.parse(headerBuf.toString('utf8'));

    const getEntry = (relPath) => {
      const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
      let node = header;
      for (const part of parts) {
        if (!node || !node.files || !Object.prototype.hasOwnProperty.call(node.files, part)) {
          return null;
        }
        node = node.files[part];
      }
      return node;
    };

    const hasFile = (relPath) => {
      const entry = getEntry(relPath);
      return Boolean(entry && !entry.files);
    };

    const readFileBuffer = (relPath) => {
      const entry = getEntry(relPath);
      if (!entry || entry.files) {
        throw new Error(`ASAR entry not found or is a directory: ${relPath}`);
      }
      if (entry.unpacked) {
        const unpackedFile = path.join(`${asarPath}.unpacked`, ...relPath.split('/'));
        return fs.readFileSync(unpackedFile);
      }
      const size = Number(entry.size || 0);
      const offset = Number(entry.offset || 0);
      const buf = Buffer.alloc(size);
      if (size > 0) {
        const localFd = fs.openSync(asarPath, 'r');
        try {
          fs.readSync(localFd, buf, 0, size, dataOffset + offset);
        } finally {
          fs.closeSync(localFd);
        }
      }
      return buf;
    };

    const readFileUtf8 = (relPath) => readFileBuffer(relPath).toString('utf8');

    return {
      asarPath,
      header,
      dataOffset,
      getEntry,
      hasFile,
      readFileBuffer,
      readFileUtf8
    };
  } finally {
    fs.closeSync(fd);
  }
}

function serializeAsarHeader(header) {
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const alignedLen = align4(jsonBuf.length);
  const headerPicklePayloadSize = 4 + alignedLen;
  const headerPickleTotalSize = 4 + headerPicklePayloadSize;

  const buf = Buffer.alloc(16 + alignedLen, 0);
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(headerPickleTotalSize, 4);
  buf.writeUInt32LE(headerPicklePayloadSize, 8);
  buf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(buf, 16);
  return buf;
}

/**
 * Patches an ASAR archive with added, replaced, or deleted files.
 * Preserves all untouched packed files, unpacked entries, links, executable flags, and integrity metadata.
 */
function patchAsar(srcAsarPath, dstAsarPath, modifications) {
  const src = readAsar(srcAsarPath);
  const normMods = new Map();
  for (const [k, v] of Object.entries(modifications || {})) {
    const normKey = k.replace(/\\/g, '/').replace(/^\/+/, '');
    if (v === null) {
      normMods.set(normKey, null);
    } else if (Buffer.isBuffer(v)) {
      normMods.set(normKey, v);
    } else {
      normMods.set(normKey, Buffer.from(String(v), 'utf8'));
    }
  }

  const packedChunks = [];
  let currentOffset = 0;

  const srcFd = fs.openSync(srcAsarPath, 'r');
  try {
    function cloneAndCollect(srcNode, prefix) {
      const outFiles = {};
      const entries = Object.entries(srcNode.files || {});
      for (const [name, entry] of entries) {
        const relPath = prefix ? `${prefix}/${name}` : name;
        if (entry.files) {
          outFiles[name] = { files: cloneAndCollect(entry, relPath) };
          continue;
        }

        if (normMods.has(relPath)) {
          const modVal = normMods.get(relPath);
          normMods.delete(relPath);
          if (modVal === null) {
            continue; // Deleted
          }
          const newEntry = {
            size: modVal.length,
            offset: String(currentOffset),
            integrity: computeIntegrity(modVal)
          };
          if (entry.executable) newEntry.executable = true;
          packedChunks.push(modVal);
          currentOffset += modVal.length;
          outFiles[name] = newEntry;
          continue;
        }

        if (entry.unpacked || entry.link) {
          outFiles[name] = JSON.parse(JSON.stringify(entry));
          continue;
        }

        const size = Number(entry.size || 0);
        const offset = Number(entry.offset || 0);
        const buf = Buffer.alloc(size);
        if (size > 0) {
          fs.readSync(srcFd, buf, 0, size, src.dataOffset + offset);
        }
        const cloned = JSON.parse(JSON.stringify(entry));
        cloned.offset = String(currentOffset);
        if (!cloned.integrity) {
          cloned.integrity = computeIntegrity(buf);
        }
        packedChunks.push(buf);
        currentOffset += size;
        outFiles[name] = cloned;
      }
      return outFiles;
    }

    const newHeader = { files: cloneAndCollect(src.header, '') };

    // Insert any newly added files
    for (const [relPath, modVal] of normMods.entries()) {
      if (modVal === null) continue;
      const parts = relPath.split('/').filter(Boolean);
      let cur = newHeader;
      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i];
        if (!cur.files[dirName]) {
          cur.files[dirName] = { files: {} };
        }
        cur = cur.files[dirName];
      }
      const fileName = parts[parts.length - 1];
      cur.files[fileName] = {
        size: modVal.length,
        offset: String(currentOffset),
        integrity: computeIntegrity(modVal)
      };
      packedChunks.push(modVal);
      currentOffset += modVal.length;
    }

    const headerBytes = serializeAsarHeader(newHeader);
    const tmpOut = `${dstAsarPath}.tmp-${process.pid}-${Date.now()}`;
    const outFd = fs.openSync(tmpOut, 'w');
    try {
      fs.writeSync(outFd, headerBytes);
      for (const chunk of packedChunks) {
        if (chunk.length > 0) {
          fs.writeSync(outFd, chunk);
        }
      }
    } finally {
      fs.closeSync(outFd);
    }

    try {
      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          fs.renameSync(tmpOut, dstAsarPath);
          break;
        } catch (err) {
          const isLockErr = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES');
          if (!isLockErr || attempt === maxAttempts) {
            throw err;
          }
          sleepSync(300);
        }
      }
    } catch (err) {
      try { fs.unlinkSync(tmpOut); } catch (_) { }
      throw err;
    }
  } finally {
    fs.closeSync(srcFd);
  }
}

module.exports = {
  computeIntegrity,
  readAsar,
  patchAsar,
  serializeAsarHeader
};
