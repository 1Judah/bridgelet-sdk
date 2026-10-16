import { validate } from 'class-validator';
import { IsSafeWebhookUrl } from './safe-webhook-url.validator.js';

class Dto {
  @IsSafeWebhookUrl()
  url!: string;
}

async function isValid(url: string): Promise<boolean> {
  const dto = new Dto();
  dto.url = url;
  return (await validate(dto)).length === 0;
}

describe('IsSafeWebhookUrl (SSRF guard, issue #756)', () => {
  it.each([
    'https://example.com/hook',
    'https://8.8.8.8/hook',
    'https://hooks.partner.io:8443/path',
  ])('accepts public target %s', async (url) => {
    expect(await isValid(url)).toBe(true);
  });

  it.each([
    'http://localhost/hook',
    'http://foo.localhost/hook',
    'http://metadata.google.internal/hook',
    'http://127.0.0.1/hook',
    'http://0.0.0.0/hook',
    'http://10.0.0.5/hook',
    'http://172.16.0.1/hook',
    'http://192.168.1.1/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/hook',
    'http://[::1]/hook',
    'http://[::]/hook',
    'http://[fd00::1]/hook',
    'http://[fe80::1]/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://[::ffff:a9fe:a9fe]/hook',
    'not-a-url',
  ])('rejects internal target %s', async (url) => {
    expect(await isValid(url)).toBe(false);
  });
});
