import {
  IsUrl,
  IsArray,
  IsIn,
  IsString,
  IsOptional,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsSafeWebhookUrl } from '../../../common/validators/safe-webhook-url.validator.js';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENTS_MESSAGE,
} from '../webhook-events.js';

export class CreateWebhookDto {
  @ApiProperty({ example: 'https://api.example.com/hooks' })
  @IsUrl({ require_tld: false })
  // Verified for #695 (duplicate of the already-resolved #634, fixed in PR #776):
  // rejects localhost, link-local and cloud-metadata (e.g. 169.254.169.254) targets.
  @IsSafeWebhookUrl()
  url: string;

  @ApiProperty({
    example: [
      'sweep.completed',
      'sweep.failed',
      'account.created',
      'account.expired',
    ],
    description: 'Event types to subscribe to',
    enum: WEBHOOK_EVENTS,
  })
  @IsArray()
  @IsString({ each: true })
  // #913 — an unknown event name is rejected here rather than silently creating
  // a subscription that never fires.
  @IsIn(WEBHOOK_EVENTS, { each: true, message: WEBHOOK_EVENTS_MESSAGE })
  events: string[];

  @ApiProperty({
    required: false,
    example: 'my-webhook-secret',
    description:
      'Secret used to sign outbound payloads via X-Bridgelet-Signature header',
  })
  @IsOptional()
  @IsString()
  @MinLength(16, { message: 'secret must be at least 16 characters long' })
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'secret may only contain letters, numbers, "_" and "-"',
  })
  secret?: string;

  @ApiProperty({ required: false, example: 'Payroll completion hook' })
  @IsOptional()
  @IsString()
  description?: string;
}
