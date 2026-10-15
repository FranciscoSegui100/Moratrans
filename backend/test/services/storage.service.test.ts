import { describe, it, expect } from 'vitest';
import { detectarExtensionSegura } from '../../src/services/storage.service';

describe('detectarExtensionSegura', () => {
  it('detecta PDF por magic bytes (%PDF)', () => {
    const pdfBuffer = Buffer.from('%PDF-1.5 test content');
    expect(detectarExtensionSegura(pdfBuffer, 'application/octet-stream')).toBe('pdf');
  });

  it('detecta JPEG por magic bytes (FF D8 FF)', () => {
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectarExtensionSegura(jpegBuffer)).toBe('jpg');
  });

  it('detecta PNG por magic bytes (89 50 4E 47)', () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectarExtensionSegura(pngBuffer)).toBe('png');
  });

  it('detecta WebP por estructura RIFF...WEBP', () => {
    const webpHeader = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP'),
    ]);
    expect(detectarExtensionSegura(webpHeader)).toBe('webp');
  });

  it('rechaza ejecutables y scripts desconocidos', () => {
    const exeBuffer = Buffer.from('MZ\x90\x00\x03\x00\x00\x00');
    expect(detectarExtensionSegura(exeBuffer, 'application/x-dosexec')).toBeNull();

    const bashBuffer = Buffer.from('#!/bin/bash\nrm -rf /');
    expect(detectarExtensionSegura(bashBuffer, 'text/x-shellscript')).toBeNull();
  });
});
