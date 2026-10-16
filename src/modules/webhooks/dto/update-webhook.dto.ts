import {
  IsUrl,
  IsArray,
  IsIn,
  IsString,
  IsOptional,
  IsBoolean,
  MinLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENTS_MESSAGE,
} from '../webhook-events.js';

export class UpdateWebhookDto {
  @ApiProperty({
    required: false,
    example: 'https://api.example.com/hooks',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  url?: string;

  @ApiProperty({
    required: false,
    example: [
      'sweep.completed',
      'sweep.failed',
      'account.created',
      'account.expired',
    ],
    description: 'Event types to subscribe to',
    enum: WEBHOOK_EVENTS,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  // #913 — same catalogue as create, so a rotation cannot introduce an unknown
  // event name that silently never fires.
  @IsIn(WEBHOOK_EVENTS, { each: true, message: WEBHOOK_EVENTS_MESSAGE })
  events?: string[];

  @ApiProperty({
    required: false,
    example: 'Payroll completion hook',
    description: 'Optional description for the webhook subscription',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    required: false,
    description: 'Pause (false) or resume (true) delivery for this webhook',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    required: false,
    description:
      'New secret used to sign outbound payloads (rotates the existing one)',
  })
  @IsOptional()
  @IsString()
  @MinLength(16, { message: 'secret must be at least 16 characters long' })
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'secret may only contain letters, numbers, "_" and "-"',
  })
  secret?: string;
}
