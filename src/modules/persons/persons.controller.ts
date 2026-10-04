import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { MAX_UPLOAD_BYTES } from '../../shared/storage/image-processor';
import { ApiKeyGuard } from '../../shared/http/api-key.guard';
import { PersonsExceptionFilter } from './persons-exception.filter';
import { PersonsService } from './persons.service';
import {
  createPersonSchema,
  PersonPinPipe,
  SchemaPipe,
  targetsSchema,
  updatePersonSchema,
} from './persons-http.validation';
import type { CreatePerson, UpdatePerson } from './persons.types';

@Controller('api/persons')
@UseGuards(ApiKeyGuard)
@UseFilters(PersonsExceptionFilter)
export class PersonsController {
  constructor(private readonly persons: PersonsService) {}
  @Post()
  create(@Body(new SchemaPipe(createPersonSchema)) input: CreatePerson) {
    return this.persons.create(input);
  }
  @Get(':pin')
  get(@Param('pin', PersonPinPipe) pin: string) {
    return this.persons.get(pin);
  }
  @Patch(':pin')
  update(
    @Param('pin', PersonPinPipe) pin: string,
    @Body(new SchemaPipe(updatePersonSchema)) input: UpdatePerson,
  ) {
    return this.persons.update(pin, input);
  }
  @Put(':pin/photo')
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 2 },
    }),
  )
  upload(
    @Param('pin', PersonPinPipe) pin: string,
    @UploadedFile() photo?: Express.Multer.File,
  ) {
    if (!photo) throw new BadRequestException('Multipart field photo is required');
    return this.persons.uploadPhoto(pin, photo.buffer);
  }
  @Get(':pin/photo')
  @Header('Cache-Control', 'private, no-store')
  async photo(@Param('pin', PersonPinPipe) pin: string) {
    return new StreamableFile(await this.persons.readPhoto(pin), { type: 'image/jpeg' });
  }
  @Post(':pin/enroll')
  @HttpCode(202)
  enroll(
    @Param('pin', PersonPinPipe) pin: string,
    @Body(new SchemaPipe(targetsSchema)) input: { deviceSns: string[] },
  ) {
    return this.persons.enqueue(pin, 'enroll', input.deviceSns);
  }
  @Post(':pin/delete-profile')
  @HttpCode(202)
  remove(
    @Param('pin', PersonPinPipe) pin: string,
    @Body(new SchemaPipe(targetsSchema)) input: { deviceSns: string[] },
  ) {
    return this.persons.enqueue(pin, 'delete-profile', input.deviceSns);
  }
  @Get(':pin/operations/:id')
  operation(@Param('pin', PersonPinPipe) pin: string, @Param('id') id: string) {
    return this.persons.operation(pin, id);
  }
}
