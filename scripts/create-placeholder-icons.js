#!/usr/bin/env node

/**
 * Create minimal placeholder PNG icons
 * These are simple solid-color icons for development/testing
 * Replace with proper designed icons for production
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Create icons directory
const iconsDir = path.join(__dirname, '..', 'assets', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

/**
 * Creates a minimal valid PNG file
 * Color: Purple (#7c3aed)
 */
function createPng(size) {
  // PNG signature
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk (image header)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);  // width
  ihdrData.writeUInt32BE(size, 4);  // height
  ihdrData.writeUInt8(8, 8);        // bit depth
  ihdrData.writeUInt8(2, 9);        // color type (RGB)
  ihdrData.writeUInt8(0, 10);       // compression
  ihdrData.writeUInt8(0, 11);       // filter
  ihdrData.writeUInt8(0, 12);       // interlace
  const ihdr = createChunk('IHDR', ihdrData);

  // IDAT chunk (image data)
  // Create raw pixel data (RGB, one filter byte per row)
  const rowBytes = size * 3 + 1; // RGB + filter byte
  const rawData = Buffer.alloc(rowBytes * size);

  // Purple color: #7c3aed = RGB(124, 58, 237)
  const r = 124, g = 58, b = 237;

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    rawData[rowStart] = 0; // Filter type: None

    for (let x = 0; x < size; x++) {
      const pixelStart = rowStart + 1 + x * 3;
      rawData[pixelStart] = r;
      rawData[pixelStart + 1] = g;
      rawData[pixelStart + 2] = b;
    }
  }

  // Compress with zlib
  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idat = createChunk('IDAT', compressed);

  // IEND chunk (image end)
  const iend = createChunk('IEND', Buffer.alloc(0));

  // Combine all chunks
  return Buffer.concat([signature, ihdr, idat, iend]);
}

/**
 * Creates a PNG chunk with CRC
 */
function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  // Calculate CRC32 of type + data
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/**
 * CRC32 implementation for PNG
 */
function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = getCrcTable();

  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
  }

  return crc ^ 0xFFFFFFFF;
}

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;

  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c;
  }
  return crcTable;
}

// Generate icons
const sizes = [16, 32, 48, 128];

sizes.forEach(size => {
  const png = createPng(size);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
});

console.log('\nPlaceholder icons created successfully!');
console.log('Note: Replace these with properly designed icons for production.');
