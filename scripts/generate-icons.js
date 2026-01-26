#!/usr/bin/env node

/**
 * Generate placeholder icons for the Chrome extension
 * Run with: node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');

// SVG icon template - a simple AI/robot icon
const createSvgIcon = (size) => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#7c3aed;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#6d28d9;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.15}" fill="url(#grad)"/>
  <g transform="translate(${size * 0.15}, ${size * 0.15})">
    <!-- Robot head outline -->
    <rect
      x="${size * 0.1}"
      y="${size * 0.1}"
      width="${size * 0.5}"
      height="${size * 0.4}"
      rx="${size * 0.05}"
      fill="none"
      stroke="white"
      stroke-width="${size * 0.04}"
    />
    <!-- Eyes -->
    <circle cx="${size * 0.25}" cy="${size * 0.25}" r="${size * 0.05}" fill="white"/>
    <circle cx="${size * 0.45}" cy="${size * 0.25}" r="${size * 0.05}" fill="white"/>
    <!-- Antenna -->
    <line
      x1="${size * 0.35}"
      y1="${size * 0.1}"
      x2="${size * 0.35}"
      y2="${size * 0.02}"
      stroke="white"
      stroke-width="${size * 0.03}"
    />
    <circle cx="${size * 0.35}" cy="${size * 0.02}" r="${size * 0.03}" fill="white"/>
    <!-- Code brackets -->
    <text
      x="${size * 0.35}"
      y="${size * 0.58}"
      font-family="monospace"
      font-size="${size * 0.18}"
      fill="white"
      text-anchor="middle"
    >&lt;/&gt;</text>
  </g>
</svg>`;

// Create icons directory if it doesn't exist
const iconsDir = path.join(__dirname, '..', 'assets', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate icons for each size
const sizes = [16, 32, 48, 128];

sizes.forEach(size => {
  const svg = createSvgIcon(size);
  const svgPath = path.join(iconsDir, `icon${size}.svg`);
  fs.writeFileSync(svgPath, svg);
  console.log(`Generated ${svgPath}`);
});

console.log('\nNote: For production, convert these SVG files to PNG:');
console.log('You can use tools like:');
console.log('  - Inkscape: inkscape icon.svg -o icon.png');
console.log('  - ImageMagick: convert icon.svg icon.png');
console.log('  - Online converters');

// Create a simple PNG placeholder using base64 (1x1 purple pixel scaled)
// This is just for initial testing - replace with real icons for production
const createPlaceholderPng = (size) => {
  // Minimal valid PNG header for a purple square
  // This is a workaround - in production use proper icon files
  console.log(`\nFor icon${size}.png, please convert icon${size}.svg to PNG format`);
};

sizes.forEach(size => {
  createPlaceholderPng(size);
});
