import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

test('upgraded mail transport constructs verification mail entirely in memory', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  try {
    const mail = await transport.sendMail({
      from: 'sender@zhiyun.test',
      to: 'recipient@zhiyun.test',
      subject: 'Verification fixture',
      text: 'Local-only verification fixture',
    });
    expect(mail.envelope.to).toEqual(['recipient@zhiyun.test']);
    expect(mail.message.toString()).toContain('Local-only verification fixture');
  } finally {
    transport.close();
  }
});

test('raw mail cannot bypass disabled file access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-mail-security-'));
  const path = join(directory, 'fixture.eml');
  await writeFile(
    path,
    'From: sender@zhiyun.test\r\nTo: recipient@zhiyun.test\r\nSubject: Fixture\r\n\r\nLocal fixture',
  );
  const transport = nodemailer.createTransport(
    { streamTransport: true, buffer: true },
    { disableFileAccess: true, disableUrlAccess: true },
  );
  try {
    await expect(
      transport.sendMail({
        from: 'sender@zhiyun.test',
        to: 'recipient@zhiyun.test',
        raw: { path },
      }),
    ).rejects.toThrow(/access|disabled/i);
  } finally {
    transport.close();
    await rm(directory, { recursive: true, force: true });
  }
});
