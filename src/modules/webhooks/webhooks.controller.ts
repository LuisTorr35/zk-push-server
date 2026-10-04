import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpCode,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import { ApiKeyGuard } from '../../shared/http/api-key.guard';
import { WebhooksExceptionFilter } from './webhooks-exception.filter';
import { WebhooksService } from './webhooks.service';

@Controller('api/webhooks/deliveries')
@UseGuards(ApiKeyGuard)
@UseFilters(WebhooksExceptionFilter)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}
  @Get()
  list(@Query() query: unknown) {
    return this.webhooks.list(query);
  }
  @Get(':id')
  get(@Param('id') id: string) {
    return this.webhooks.get(id);
  }
  @Post(':id/retry')
  @HttpCode(202)
  retry(@Param('id') id: string) {
    return this.webhooks.retry(id);
  }
}
